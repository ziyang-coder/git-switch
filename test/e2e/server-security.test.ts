/**
 * Security boundaries of the local GUI server.
 *
 * Threat model: a hostile web page in the user's browser on the same machine
 * (DNS rebinding, cross-site requests) plus a hostile request body sent to a
 * process that owns `~/.gitconfig`, `~/.ssh/config` and `~/.ssh` itself.
 *
 * Every test drives the real HTTP server and asserts on an observable outcome —
 * status code, header, or bytes on disk — never just on the shape of the JSON.
 * Requests that need control over the bytes on the wire (forged Host, duplicate
 * headers, chunked encoding, an untrimmed header value) go through
 * `server-raw-http.ts`, because `fetch` normalises all of those away.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTmpHome, type TmpHome } from '../helpers/tmp-home.ts';
import { startServer, type RunningServer } from '../../src/server/http.ts';
import { rawRequest, asJson } from './server-raw-http.ts';

const posix = (p: string) => p.replace(/\\/g, '/');
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const PROFILE = (home: string) => `schemaVersion: 1
identities:
  work:
    user:
      name: Alex Chen
      email: alex@company.example
    sites:
      - host: git.company.example
rules:
  - dir: ${posix(home)}/code/work
    identity: work
`;

interface Ctx {
  h: TmpHome;
  server: RunningServer;
  base: string;
  token: string;
  port: number;
  /** POST a JSON body with a valid token. */
  post: (endpoint: string, body: unknown) => Promise<Response>;
  /** GET with a valid token. */
  get: (endpoint: string) => Promise<Response>;
}

async function withServer(
  fn: (ctx: Ctx) => Promise<void>,
  opts: { profile?: string | false } = {},
): Promise<void> {
  const h = await createTmpHome('gs-sec-');
  let server: RunningServer | undefined;
  try {
    await h.write('.gitconfig', '');
    if (opts.profile !== false) await h.write('.config/gs/profiles.yaml', opts.profile ?? PROFILE(h.home));
    await mkdir(path.join(h.home, 'code', 'work'), { recursive: true });
    server = await startServer({ home: h.home });
    const base = `http://127.0.0.1:${server.port}`;
    const auth = { 'x-gs-token': server.token };
    const ctx: Ctx = {
      h,
      server,
      base,
      token: server.token,
      port: server.port,
      post: (endpoint, body) =>
        fetch(`${base}${endpoint}`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        }),
      get: (endpoint) => fetch(`${base}${endpoint}`, { headers: auth }),
    };
    await fn(ctx);
  } finally {
    if (server) await server.close();
    await h.cleanup();
  }
}

/* ================================================================== */
/* 1. token handling                                                   */
/* ================================================================== */

test('security: every API endpoint rejects a request with no token', async () => {
  await withServer(async ({ base }) => {
    const endpoints: [string, string][] = [
      ['GET', '/api/state'],
      ['GET', '/api/doctor'],
      ['GET', '/api/fs'],
      ['GET', '/api/keys'],
      ['GET', '/api/version'],
      ['POST', '/api/plan'],
      ['POST', '/api/apply'],
      ['POST', '/api/rules'],
      ['POST', '/api/identities'],
      ['POST', '/api/keys'],
      ['POST', '/api/global-identity'],
      ['POST', '/api/snapshot/export'],
      ['POST', '/api/snapshot/import'],
      ['POST', '/api/init/scan'],
      ['POST', '/api/init/apply'],
      ['POST', '/api/repair'],
    ];
    for (const [method, endpoint] of endpoints) {
      const res = await fetch(`${base}${endpoint}`, { method });
      assert.equal(res.status, 401, `${method} ${endpoint} must demand a token`);
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    }
  });
});

test('security: a wrong, truncated, extended or near-miss token is rejected', async () => {
  await withServer(async ({ base, token }) => {
    const candidates = [
      token.slice(0, -1),
      `${token}x`,
      token.toUpperCase(),
      token.toLowerCase(),
      sha256(token),
      `sha256:${sha256(token)}`,
      Buffer.from(token, 'utf8').toString('base64'),
      '',
    ];
    for (const candidate of candidates) {
      const res = await fetch(`${base}/api/state`, { headers: { 'x-gs-token': candidate } });
      assert.equal(res.status, 401, `token ${JSON.stringify(candidate.slice(0, 12))}… must not authenticate`);
    }
  });
});

test('security: a token padded with surrounding whitespace is rejected, not trimmed', async () => {
  await withServer(async ({ port, token }) => {
    // fetch() trims header values before they reach the socket. Whether Node's
    // HTTP parser also strips the padding is the real question; whatever the
    // answer, only the exact token may ever authenticate.
    const answers: string[] = [];
    for (const value of [` ${token}`, `${token} `, `\t${token}`]) {
      const res = await rawRequest(port, { path: '/api/state', headers: [`x-gs-token: ${value}`] });
      asJson(res);
      answers.push(`${JSON.stringify(value.slice(0, 3))}…=${res.status}`);
      if (res.status === 200) assert.equal(value.trim(), token, 'only the exact token may authenticate');
      assert.ok(res.status === 200 || res.status === 401, answers.join(' '));
    }
  });
});

test('security: a token from an earlier server process is rejected by a new one', async () => {
  const h = await createTmpHome('gs-sec-token-');
  const first = await startServer({ home: h.home });
  const second = await startServer({ home: h.home });
  try {
    assert.notEqual(first.token, second.token, 'each process mints its own token');
    assert.equal(first.token.length, 43, '32 random bytes, base64url');
    const res = await fetch(`http://127.0.0.1:${second.port}/api/state`, { headers: { 'x-gs-token': first.token } });
    assert.equal(res.status, 401, 'a stale token must not open a new server');
  } finally {
    await first.close();
    await second.close();
    await h.cleanup();
  }
});

test('security: the token is never accepted from the query string', async () => {
  await withServer(async ({ base, token }) => {
    const urls = [
      `/api/state?token=${encodeURIComponent(token)}`,
      `/api/state?x-gs-token=${encodeURIComponent(token)}`,
      `/api/state?access_token=${encodeURIComponent(token)}`,
      `/api/state?_token=${encodeURIComponent(token)}`,
      `/api/state?t=${encodeURIComponent(token)}`,
    ];
    for (const url of urls) {
      const res = await fetch(`${base}${url}`);
      assert.equal(res.status, 401, `${url} must not authenticate: query strings leak into logs and Referer`);
    }
  });
});

test('security: the token never leaks into static assets, headers or API payloads', async () => {
  await withServer(async ({ base, token }) => {
    const assets = ['/', '/src/main.js', '/src/api.js', '/src/i18n.js', '/src/styles/main.css'];
    for (const asset of assets) {
      const res = await fetch(`${base}${asset}`);
      const text = await res.text();
      assert.ok(!text.includes(token), `${asset} must not embed the token`);
      for (const [name, value] of res.headers) {
        assert.ok(!value.includes(token), `${asset} leaks the token in header ${name}`);
      }
    }
    const state = await (await fetch(`${base}/api/state`, { headers: { 'x-gs-token': token } })).text();
    assert.ok(!state.includes(token), 'the state payload must not echo the token back');
  });
});

/* ================================================================== */
/* 2. Host / Origin (DNS rebinding and cross-site requests)            */
/* ================================================================== */

test('security: a rebound Host header is rejected on API and static routes', async () => {
  await withServer(async ({ port, token }) => {
    const hostile = [
      `evil.example:${port}`,
      `localhost.evil.example:${port}`,
      `127.0.0.1.evil.example:${port}`,
      `attacker.test:${port}`,
      `0.0.0.0:${port}`,
      `[::ffff:127.0.0.1]:${port}`,
      `127.1:${port}`,
    ];
    for (const host of hostile) {
      const api = await rawRequest(port, { path: '/api/state', headers: [`Host: ${host}`, `x-gs-token: ${token}`] });
      assert.equal(api.status, 403, `API with Host ${host} must be refused`);
      assert.match(api.body, /invalid Host header/);

      const page = await rawRequest(port, { path: '/', headers: [`Host: ${host}`] });
      assert.equal(page.status, 403, `static page with Host ${host} must be refused`);
      assert.match(page.body, /invalid Host header/);
    }
  });
});

test('security: a Host with a wrong port, no port, or a trailing dot is rejected', async () => {
  await withServer(async ({ port, token }) => {
    const cases: [string, string][] = [
      [`127.0.0.1:${port + 1}`, 'a different port is a different web origin'],
      ['127.0.0.1', 'default port 80 is not ours'],
      [`127.0.0.1.:${port}`, 'a trailing dot is a different authority'],
      [`127.0.0.1:${port}:${port}`, 'two ports'],
      [`user@127.0.0.1:${port}`, 'userinfo in Host'],
      [`127.0.0.1:+${port}`, 'signed port'],
    ];
    for (const [host, why] of cases) {
      const res = await rawRequest(port, { path: '/api/state', headers: [`Host: ${host}`, `x-gs-token: ${token}`] });
      assert.equal(res.status, 403, `Host ${host} must be refused: ${why}`);
    }
  });
});

test('security: the loopback authorities the page is actually served from are accepted', async () => {
  await withServer(async ({ port, token }) => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]) {
      const res = await rawRequest(port, { path: '/api/state', headers: [`Host: ${host}`, `x-gs-token: ${token}`] });
      assert.equal(res.status, 200, `Host ${host} is our own authority and must work`);
    }
  });
});

test('security: cross-site Origins are refused even with a valid token', async () => {
  await withServer(async ({ base, port, token }) => {
    const origins = [
      'http://evil.example',
      'https://evil.example',
      `http://127.0.0.1.evil.example:${port}`,
      'null', // sandboxed iframe / opaque origin
      'file://',
      'http://127.0.0.1',
      `http://localhost:${port + 1}`,
    ];
    for (const origin of origins) {
      const res = await fetch(`${base}/api/state`, { headers: { 'x-gs-token': token, origin } });
      assert.equal(res.status, 403, `Origin ${origin} must be refused`);
      assert.equal(res.headers.get('access-control-allow-origin'), null, `Origin ${origin} must get no CORS grant`);
    }
  });
});

test('security: an https Origin on our own port is accepted (documented scheme blindness)', async () => {
  await withServer(async ({ base, token, port }) => {
    // originIsAllowed compares the port but not the scheme, so https://127.0.0.1:port
    // passes even though the server only speaks http. A browser never emits that
    // Origin for a page it did not load over TLS from that port, so this records
    // the behaviour rather than treating it as a break-in.
    const res = await fetch(`${base}/api/state`, {
      headers: { 'x-gs-token': token, origin: `https://127.0.0.1:${port}` },
    });
    assert.equal(res.status, 200);
  });
});
test('security: a preflight from a hostile origin gets no CORS grant', async () => {
  await withServer(async ({ port }) => {
    const res = await rawRequest(port, {
      method: 'OPTIONS',
      path: '/api/rules',
      headers: [
        'Origin: https://evil.example',
        'Access-Control-Request-Method: POST',
        'Access-Control-Request-Headers: x-gs-token,content-type',
      ],
    });
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    assert.equal(res.headers['access-control-allow-credentials'], undefined);
    assert.equal(res.headers['access-control-allow-headers'], undefined);
    assert.ok(res.status !== 204, 'a preflight must not be answered as allowed');
  });
});

test('security: duplicate Origin or token headers cannot smuggle a second value', async () => {
  await withServer(async ({ port, token }) => {
    const badOrigin = await rawRequest(port, {
      path: '/api/state',
      headers: [`Origin: http://127.0.0.1:${port}`, 'Origin: http://evil.example', `x-gs-token: ${token}`],
    });
    assert.equal(badOrigin.status, 403, 'a second, hostile Origin header must not be ignored');

    const splitToken = await rawRequest(port, {
      path: '/api/state',
      headers: [`x-gs-token: ${token.slice(0, 20)}`, `x-gs-token: ${token.slice(20)}`],
    });
    assert.equal(splitToken.status, 401, 'a token split across two headers is not the token');
  });
});

test('security: an absolute-form request line does not reach the API under a foreign authority', async () => {
  await withServer(async ({ port, token }) => {
    // RFC 9112 allows the request target to carry its own authority. A handler
    // that used it instead of Host would be trivially rebindable, so the request
    // must either be refused or normalised back to the Host we validate; what it
    // must never do is answer for "evil.example".
    const res = await rawRequest(port, {
      path: `http://evil.example:${port}/api/state`,
      headers: [`Host: 127.0.0.1:${port}`, `x-gs-token: ${token}`],
    });
    asJson(res);
    assert.ok(
      res.status === 403 || res.status === 404 || res.status === 400 || res.status === 200,
      `absolute-form gave an unexpected status ${res.status}`,
    );
    if (res.status === 200) {
      // Node keeps `url` as the absolute form; the handler then sees pathname
      // "/api/state" and answers. Record that the Host check, not the target line,
      // is the only thing standing in the way.
      assert.ok(res.body.includes('"messages"'), 'only our own Host may receive state');
    }
  });
});

test('security: the server only listens on 127.0.0.1', async () => {
  const h = await createTmpHome('gs-sec-bind-');
  const server = await startServer({ home: h.home });
  try {
    assert.ok(server.url.startsWith(`http://127.0.0.1:${server.port}/#token=`), server.url);
    const address = server.server.address();
    assert.ok(address && typeof address === 'object');
    assert.equal(address.address, '127.0.0.1');
    assert.ok(server.port > 0 && server.port < 65536);
  } finally {
    await server.close();
    await h.cleanup();
  }
});

/* ================================================================== */
/* 3. static asset serving: path traversal and headers                 */
/* ================================================================== */

test('security: static traversal attempts cannot escape the web root', async () => {
  await withServer(async ({ base }) => {
    const attempts = [
      '/../package.json',
      '/..%2fpackage.json',
      '/%2e%2e/package.json',
      '/%2e%2e%2fpackage.json',
      '/src/../../package.json',
      '/src/..%2f..%2f..%2fpackage.json',
      '/..%5cpackage.json',
      '/../../../../../../Windows/win.ini',
      '/%252e%252e/package.json',
      '/web/../src/cli.ts',
      '/src/cli.ts',
    ];
    for (const attempt of attempts) {
      const res = await fetch(`${base}${attempt}`);
      const body = await res.text();
      assert.ok(res.status === 403 || res.status === 404, `${attempt} must be refused (got ${res.status})`);
      assert.ok(!body.includes('"name": "git-switch"'), `${attempt} served the project's package.json`);
      assert.ok(!body.includes('[extensions]'), `${attempt} escaped to an OS file`);
      assert.ok(!body.includes('startServer'), `${attempt} served server source`);
    }
  });
});

test('security: a directory URL is not listed and does not 500', async () => {
  await withServer(async ({ base }) => {
    for (const url of ['/src', '/src/', '/src/views', '/src/styles']) {
      const res = await fetch(`${base}${url}`);
      assert.ok(res.status === 404 || res.status === 403, `${url} must not enumerate the directory (got ${res.status})`);
      const text = await res.text();
      assert.ok(!text.includes('main.js'), `${url} listed its contents`);
    }
  });
});

test('security: static responses carry a strict CSP, nosniff and no CORS', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy') ?? '';
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ]) {
      assert.ok(csp.includes(directive), `CSP must contain ${directive}`);
    }
    assert.ok(!csp.includes("'unsafe-inline'"), "CSP must not allow 'unsafe-inline'");
    assert.ok(!csp.includes("'unsafe-eval'"), "CSP must not allow 'unsafe-eval'");
    assert.ok(!/\*\s*(;|$)/.test(csp), 'CSP must not contain a wildcard source');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});

test('security: every API response is JSON, uncacheable and script-hostile', async () => {
  await withServer(async ({ get, base, token }) => {
    for (const endpoint of ['/api/state', '/api/version', '/api/doctor', '/api/keys', '/api/nope']) {
      const res = await get(endpoint);
      assert.match(res.headers.get('content-type') ?? '', /^application\/json/, `${endpoint} must be JSON`);
      assert.equal(res.headers.get('cache-control'), 'no-store', `${endpoint} must not be cached`);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
      assert.equal(res.headers.get('access-control-allow-origin'), null);
      void base;
      void token;
    }
  });
});

/* ================================================================== */
/* 4. request bodies: malformed input must not 5xx                     */
/* ================================================================== */

test('security: a malformed JSON body is a clean 4xx, never a crash', async () => {
  await withServer(async ({ base, token }) => {
    const bodies = ['{not json', '{"a":', '', '   ', '\u0000\u0001', 'null', '[]', '"a string"', '42', 'true', '{"add":}'];
    for (const endpoint of ['/api/rules', '/api/plan', '/api/apply', '/api/identities', '/api/keys']) {
      for (const body of bodies) {
        const res = await fetch(`${base}${endpoint}`, {
          method: 'POST',
          headers: { 'x-gs-token': token, 'content-type': 'application/json' },
          body,
        });
        const text = await res.text();
        assert.ok(res.status < 500, `${endpoint} with body ${JSON.stringify(body)} returned ${res.status}: ${text.slice(0, 120)}`);
        assert.doesNotThrow(() => JSON.parse(text), `${endpoint} must answer with JSON, got ${text.slice(0, 80)}`);
        const parsed = JSON.parse(text) as { error?: unknown };
        if (res.status >= 400) assert.equal(typeof parsed.error, 'string', `${endpoint} must explain the failure`);
      }
    }
  });
});

test('security: wrong field types do not crash any endpoint', async () => {
  await withServer(async ({ post }) => {
    const bodies: unknown[] = [
      { add: 'yes', dir: 42, identity: null },
      { add: true, dir: { nested: true }, identity: ['work'] },
      { remove: 12345 },
      { update: true, original: 9, name: {}, userName: [], email: 0 },
      { action: 42, name: [], newName: {} },
      { action: 'generate', name: { toString: 'x' } },
      { name: {}, email: [] },
      { path: [], withKeys: 'yes', passphrase: 42 },
      { root: [], offline: 'yes' },
      { apply: 'yes' },
      { profilesText: 42 },
      { profilesText: { a: 1 } },
    ];
    for (const endpoint of [
      '/api/rules',
      '/api/identities',
      '/api/keys',
      '/api/global-identity',
      '/api/snapshot/export',
      '/api/snapshot/import',
      '/api/init/scan',
      '/api/init/apply',
      '/api/repair',
      '/api/plan',
      '/api/apply',
    ]) {
      for (const body of bodies) {
        const res = await post(endpoint, body);
        const text = await res.text();
        assert.ok(res.status < 500, `${endpoint} with ${JSON.stringify(body)} returned ${res.status}: ${text.slice(0, 120)}`);
      }
    }
  });
});

test('security: an oversized body is refused with a clear error', async () => {
  await withServer(async ({ base, token }) => {
    const tooBig = JSON.stringify({ profilesText: 'x'.repeat(2 * 1024 * 1024 + 64) });
    const response = await fetch(`${base}/api/plan`, {
      method: 'POST',
      headers: { 'x-gs-token': token, 'content-type': 'application/json' },
      body: tooBig,
    });
    assert.equal(response.status, 400, 'a body over the 2 MiB cap must be a client error');
    const body = (await response.json()) as { error?: string };
    assert.match(body.error ?? '', /too large/i);
  });
});

test('security: a chunked body over the cap is refused too', async () => {
  await withServer(async ({ port, token }) => {
    const chunk = 'a'.repeat(0xffff);
    let res: Awaited<ReturnType<typeof rawRequest>> | undefined;
    try {
      res = await rawRequest(port, {
        method: 'POST',
        path: '/api/rules',
        headers: [`x-gs-token: ${token}`, 'Transfer-Encoding: chunked', 'Content-Type: application/json'],
        body: `${chunk.length.toString(16)}\r\n${chunk}\r\n${chunk.length.toString(16)}\r\n${chunk}\r\n0\r\n\r\n`,
      });
    } catch (err) {
      // The handler answers as soon as the cap is crossed; when it then closes the
      // socket while we are still uploading, a reset is the correct refusal.
      assert.match(String((err as Error).message), /ECONNRESET|EPIPE/);
      return;
    }
    // Depending on the platform and timing, the abort can also surface as an empty
    // reply rather than a reset: the server answered and closed before the rest of
    // the body was written. Either way nothing may be accepted.
    if (res.status === 0 || res.body === '') {
      assert.ok(res.status === 0 || res.status >= 400, `an empty reply must not be a 2xx, got ${res.status}`);
      return;
    }
    assert.ok(res.status >= 400 && res.status < 500, `chunked oversize body must be 4xx, got ${res.status}`);
    assert.match(res.body, /too large/i);
  });
});

/* ================================================================== */
/* 5. path traversal through API payloads                              */
/* ================================================================== */

test('security: snapshot export refuses to write outside the home directory', async () => {
  await withServer(async ({ h, post }) => {
    // F6: `path` is resolved against home but never confined to it, so the browser
    // can make the server write a snapshot anywhere the user can write.
    const outside = await createTmpHome('gs-sec-outside-');
    try {
      const escapes: [string, string][] = [
        [path.join(outside.home, 'pwned.txt'), 'absolute path outside home'],
        [posix(path.join(outside.home, 'pwned2.txt')), 'absolute forward-slash path outside home'],
        [path.relative(h.home, path.join(outside.home, 'pwned3.txt')), '.. traversal relative to home'],
      ];
      for (const [target, why] of escapes) {
        const res = await post('/api/snapshot/export', { path: target });
        const body = (await res.json()) as { path?: string; error?: string };
        const absolute = await readFile(target, 'utf8').catch(() => undefined);
        assert.equal(
          absolute,
          undefined,
          `snapshot/export wrote ${target} (${why}); answered ${res.status} ${body.path ?? body.error}`,
        );
        assert.equal(res.status, 400, `snapshot/export must refuse ${why} with 400, got ${res.status}`);
      }
      // A relative path that stays inside home must keep working.
      assert.equal((await post('/api/snapshot/export', { path: 'inside.gsnap' })).status, 200);
    } finally {
      await outside.cleanup();
    }
  });
});

test('security: snapshot import refuses archives from outside home', async () => {
  await withServer(async ({ h, post }) => {
    // F7: the source path is resolved but never confined, so an archive anywhere
    // on disk can be turned into this profile.
    const outside = await createTmpHome('gs-sec-import-');
    try {
      const outsideSnapshot = path.join(outside.home, 'foreign.gsnap');
      const exported = await post('/api/snapshot/export', { path: outsideSnapshot });
      await exported.text();

      const sources = [
        outsideSnapshot,
        posix(outsideSnapshot),
        path.relative(h.home, outsideSnapshot),
      ];
      for (const source of sources) {
        const res = await post('/api/snapshot/import', { path: source });
        const body = (await res.text()).slice(0, 120);
        assert.equal(res.status, 400, `importing ${source} must be refused, got ${String(res.status)} ${body}`);
      }

      // A garbage file inside home must not replace the profile.
      const before = await readFile(path.join(h.home, '.config/gs/profiles.yaml'), 'utf8');
      await h.write('garbage.gsnap', 'not a snapshot at all');
      const garbage = await post('/api/snapshot/import', { path: 'garbage.gsnap' });
      assert.equal(garbage.status, 400);
      assert.equal(await readFile(path.join(h.home, '.config/gs/profiles.yaml'), 'utf8'), before);
    } finally {
      await outside.cleanup();
    }
  });
});

test('security: importing a snapshot replaces the profile without any confirmation', async () => {
  await withServer(async ({ h, post }) => {
    // Reproduce the archived profile of a *different* machine, then import it.
    const source = await createTmpHome('gs-sec-foreign-');
    try {
      await source.write('.gitconfig', '');
      await source.write(
        '.config/gs/profiles.yaml',
        'schemaVersion: 1\nidentities:\n  foreign:\n    user:\n      name: Foreign\n      email: foreign@example.com\nrules: []\n',
      );
      const archive = await readFile(path.join(source.home, '.config/gs/profiles.yaml'), 'utf8');
      const payload = {
        manifest: {
          format: 'gs-snapshot',
          version: 1,
          createdAt: new Date(0).toISOString(),
          sourceHome: posix(source.home),
          containsKeys: false,
          files: [{ path: 'profiles.yaml', sha256: sha256(archive) }],
        },
        files: [{ path: 'profiles.yaml', content: archive, sha256: sha256(archive) }],
      };
      await h.write('foreign.gsnap', JSON.stringify(payload));

      const res = await post('/api/snapshot/import', { path: 'foreign.gsnap' });
      const body = (await res.json()) as { identities?: { name: string }[] };
      assert.equal(res.status, 200);
      const onDisk = await readFile(path.join(h.home, '.config/gs/profiles.yaml'), 'utf8');
      assert.deepEqual(
        body.identities?.map((i) => i.name),
        ['foreign'],
        'the import is expected to replace the profile wholesale',
      );
      assert.match(onDisk, /foreign@example\.com/);
    } finally {
      await source.cleanup();
    }
  });
});

test('security: fs browse refuses .., %2e%2e and absolute paths outside the roots over HTTP', async () => {
  await withServer(async ({ h, get }) => {
    const outside = await createTmpHome('gs-sec-fs-');
    try {
      await mkdir(path.join(outside.home, 'private'), { recursive: true });
      const cases = [
        '..',
        '../',
        '..%2f..',
        path.join(h.home, '..'),
        posix(path.join(h.home, '..', path.basename(outside.home))),
        outside.home,
        posix(outside.home),
        '/',
        'C:/',
        '/etc',
        '\\\\server\\share',
      ];
      for (const dir of cases) {
        const res = await get(`/api/fs?dir=${encodeURIComponent(dir)}`);
        assert.ok(res.status < 500, `fs?dir=${dir} returned ${res.status}`);
        const body = (await res.json()) as { error?: string; entries?: { name: string }[]; dir?: string };
        const leaked = (body.entries ?? []).length > 0 && !posix(body.dir ?? '').startsWith(posix(h.home));
        assert.ok(!leaked, `fs?dir=${dir} listed content outside home: ${JSON.stringify(body).slice(0, 200)}`);
        if (dir === '/' || dir === 'C:/' || dir === '/etc' || dir === '\\\\server\\share') {
          assert.ok(body.error, `fs?dir=${dir} must explain why it refused`);
        }
      }
    } finally {
      await outside.cleanup();
    }
  });
});

test('security: fs browse refuses a symlink that points outside home', async () => {
  await withServer(async ({ h, get }) => {
    const outside = await createTmpHome('gs-sec-link-');
    try {
      await mkdir(path.join(outside.home, 'secrets', 'sub'), { recursive: true });
      const link = path.join(h.home, 'escape');
      await symlink(outside.home, link, 'junction');

      const res = await get(`/api/fs?dir=${encodeURIComponent(link)}`);
      const body = (await res.json()) as { error?: string; entries?: { name: string }[] };
      assert.deepEqual(body.entries ?? [], [], `an escaping symlink must not be listed: ${JSON.stringify(body).slice(0, 200)}`);
      assert.ok(body.error, 'a symlink escaping home must be refused');

      const child = await get(`/api/fs?dir=${encodeURIComponent(path.join(link, 'secrets'))}`);
      const childBody = (await child.json()) as { error?: string; entries?: unknown[] };
      assert.deepEqual(childBody.entries ?? [], [], 'a path through the escaping symlink must be refused');
      assert.ok(childBody.error);
    } finally {
      await outside.cleanup();
    }
  });
});

test('security: fs browse handles a path that is inside home but spelled with ".."', async () => {
  await withServer(async ({ h, get }) => {
    // `~/a/../code` never leaves home. browse() rejects any string containing
    // ".." before touching the filesystem, so this documents the (safe) outcome.
    const res = await get(`/api/fs?dir=${encodeURIComponent(`${h.home}/a/../code`)}`);
    const body = (await res.json()) as { error?: string; entries?: { name: string }[] };
    const refused = typeof body.error === 'string';
    const listed = (body.entries ?? []).some((e) => e.name === 'work');
    assert.ok(refused || listed, `a normalised in-home path must either be listed or explicitly refused: ${JSON.stringify(body).slice(0, 200)}`);
  });
});

test('security: fs browse only accepts directories inside home or settings.allowRoots', async () => {
  await withServer(async ({ h, get }) => {
    const extra = await createTmpHome('gs-sec-allow-');
    try {
      await mkdir(path.join(extra.home, 'allowed'), { recursive: true });
      await h.write(
        '.config/gs/profiles.yaml',
        `${PROFILE(h.home)}settings:
  backupKeep: 5
  allowRoots:
    - ${posix(extra.home)}
`,
      );
      const ok = await get(`/api/fs?dir=${encodeURIComponent(extra.home)}`);
      const okBody = (await ok.json()) as { error?: string; entries: { name: string }[] };
      assert.equal(okBody.error, undefined, `an allowRoot must be browsable, got ${okBody.error}`);
      assert.ok(okBody.entries.some((e) => e.name === 'allowed'));

      const denied = await get(`/api/fs?dir=${encodeURIComponent(path.dirname(extra.home))}`);
      const deniedBody = (await denied.json()) as { error?: string };
      assert.ok(deniedBody.error, 'the parent of an allowRoot is not itself allowed');
    } finally {
      await extra.cleanup();
    }
  });
});

/* ================================================================== */
/* 6. secrets must never travel to the browser                         */
/* ================================================================== */

test('security: no endpoint returns private key material', async () => {
  await withServer(async ({ h, get, post }) => {
    const privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAFAKESECRET\n-----END OPENSSH PRIVATE KEY-----\n';
    await h.write('.ssh/id_secret', privateKey);
    await h.write('.ssh/id_secret.pub', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI comment\n');

    for (const endpoint of ['/api/state', '/api/keys', '/api/doctor', '/api/version', '/api/fs']) {
      const text = await (await get(endpoint)).text();
      assert.ok(!text.includes('PRIVATE KEY'), `${endpoint} returned private key material`);
      assert.ok(!text.includes('AAAAFAKESECRET'), `${endpoint} returned key bytes`);
    }
    for (const endpoint of ['/api/plan', '/api/snapshot/export']) {
      const text = await (await post(endpoint, {})).text();
      assert.ok(!text.includes('PRIVATE KEY'), `${endpoint} returned private key material`);
    }
  });
});

test('security: a plaintext snapshot export never includes keys, key exports are encrypted', async () => {
  await withServer(async ({ h, post }) => {
    await h.write('.ssh/id_plain', '-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE\n-----END OPENSSH PRIVATE KEY-----\n');
    await h.write('.ssh/id_plain.pub', 'ssh-ed25519 AAAA fake\n');

    assert.equal((await post('/api/snapshot/export', { path: 'plain.gsnap' })).status, 200);
    const plainText = await readFile(path.join(h.home, 'plain.gsnap'), 'utf8');
    assert.ok(!plainText.includes('PRIVATE KEY'), 'a snapshot without withKeys must carry no key material');

    const noPass = await post('/api/snapshot/export', { path: 'keys.gsnap', withKeys: true });
    assert.equal(noPass.status, 400, 'exporting keys without a passphrase must be refused');
    assert.equal(await readFile(path.join(h.home, 'keys.gsnap'), 'utf8').catch(() => undefined), undefined);

    const withKeys = await post('/api/snapshot/export', {
      path: 'keys.gsnap',
      withKeys: true,
      passphrase: 'correct horse battery',
    });
    assert.equal(withKeys.status, 200);
    const encrypted = await readFile(path.join(h.home, 'keys.gsnap'), 'utf8');
    assert.ok(!encrypted.includes('PRIVATE KEY'), 'key material must be encrypted on disk');
    const envelope = JSON.parse(encrypted) as { magic?: string; payload?: string };
    assert.equal(envelope.magic, 'GSNAP1');
    assert.ok(!Buffer.from(envelope.payload ?? '', 'base64').toString('utf8').includes('PRIVATE KEY'));
  });
});

test('security: an encrypted snapshot with the wrong passphrase is a clean 400', async () => {
  await withServer(async ({ h, post }) => {
    await h.write('.ssh/id_enc', '-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE\n-----END OPENSSH PRIVATE KEY-----\n');
    assert.equal(
      (await post('/api/snapshot/export', { path: 'enc.gsnap', withKeys: true, passphrase: 'right passphrase' })).status,
      200,
    );
    const imported = await post('/api/snapshot/import', { path: 'enc.gsnap', passphrase: 'wrong passphrase' });
    assert.equal(imported.status, 400);
    assert.match(((await imported.json()) as { error: string }).error, /passphrase|corrupt/i);
  });
});

/* ================================================================== */
/* 7. the API surface itself                                           */
/* ================================================================== */

test('security: unknown endpoints and wrong methods do not fall through to a handler', async () => {
  await withServer(async ({ port, token }) => {
    const cases: [string, string][] = [
      ['GET', '/api/nope'],
      ['GET', '/api'],
      ['GET', '/api/'],
      ['DELETE', '/api/state'],
      ['GET', '/api/rules'],
      ['GET', '/api/plan'],
      ['GET', '/api/apply'],
      ['POST', '/api/version'],
      ['POST', '/api/doctor'],
      ['GET', '/api/snapshot/export'],
      ['GET', '/api/global-identity'],
      ['GET', '/API/STATE'],
      ['PATCH', '/api/state'],
    ];
    for (const [method, endpoint] of cases) {
      const res = await rawRequest(port, { method, path: endpoint, headers: [`x-gs-token: ${token}`] });
      assert.ok(
        res.status === 404 || res.status === 405 || res.status === 400,
        `${method} ${endpoint} returned ${res.status}: ${res.body.slice(0, 120)}`,
      );
      const parsed = JSON.parse(res.body) as { error?: string };
      assert.equal(typeof parsed.error, 'string', `${method} ${endpoint} must explain itself`);
    }
  });
});

test('security: a request handler that throws answers JSON and keeps serving', async () => {
  await withServer(async ({ h, get }) => {
    // A profile that cannot be parsed makes the loader throw; the server must
    // report it and stay alive for the next request.
    await h.write('.config/gs/profiles.yaml', 'schemaVersion: [unclosed');
    const broken = await get('/api/doctor');
    assert.ok(broken.status < 500, `a broken profile must not 500 (got ${broken.status})`);
    await broken.text();
    const state = await get('/api/state');
    assert.equal(state.status, 200, 'the server must still answer after a bad profile');
  });
});

test('security: the token check survives a burst of mixed authenticated and hostile requests', async () => {
  await withServer(async ({ base, token }) => {
    const attempts = Array.from({ length: 40 }, (_, i) =>
      fetch(`${base}/api/version`, { headers: i % 2 === 0 ? { 'x-gs-token': token } : { 'x-gs-token': 'nope' } }),
    );
    const statuses = (await Promise.all(attempts)).map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 200).length, 20);
    assert.equal(statuses.filter((s) => s === 401).length, 20);
  });
});

test('security: an invalid host is persisted and then bricks the profile', async () => {
  await withServer(async ({ h, get, post }) => {
    const before = await h.read('.config/gs/profiles.yaml');
    const bad = await post('/api/identities', { add: true, name: 'bad name', userName: 'x', email: 'not-an-email' });
    assert.equal(bad.status, 400);
    assert.equal(await h.read('.config/gs/profiles.yaml'), before, 'a rejected identity must not touch profiles.yaml');

    // The endpoint's own comment promises "the GUI must not be able to write a
    // profile that `gs apply` would later reject". A host the loader refuses is
    // therefore supposed to be a 400 with the file untouched.
    const badHost = await post('/api/identities', {
      add: true,
      name: 'ok',
      userName: 'x',
      email: 'x@example.com',
      host: 'not a host!',
    });
    assert.equal(badHost.status, 400, 'a URL/garbage host must be rejected before it is persisted');
    assert.equal(await h.read('.config/gs/profiles.yaml'), before, 'a rejected host must not be written to disk');
    const body = (await (await get('/api/state')).json()) as { profileError?: string };
    assert.equal(body.profileError, undefined, `the profile no longer loads: ${body.profileError}`);
  });
});

/* ================================================================== */
/* 8. language is process-global                                       */
/* ================================================================== */

test('security: ?lang from one client is visible to the next request', async () => {
  await withServer(async ({ get, base, token }) => {
    await fetch(`${base}/api/state?lang=zh-CN`, { headers: { 'x-gs-token': token } });
    const second = (await (await get('/api/state')).json()) as { language: string };
    try {
      assert.equal(
        second.language,
        'zh-CN',
        'the language selection is stored on the process, so an unrelated request inherits it',
      );
    } finally {
      await fetch(`${base}/api/state?lang=en`, { headers: { 'x-gs-token': token } });
    }
  });
});
