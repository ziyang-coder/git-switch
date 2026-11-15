/**
 * Behaviour of every `/api/*` endpoint: the contract the browser relies on, the
 * degradation path when the profile on disk is damaged, and what happens when two
 * requests touch the same file at once.
 *
 * Security-shaped assertions live in `server-security.test.ts`; this file covers
 * what each endpoint is supposed to *do*, because a server that answers 500 for
 * a damaged profile is a denial of service against the user's own GUI.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTmpHome, type TmpHome } from '../helpers/tmp-home.ts';
import { startServer, type RunningServer } from '../../src/server/http.ts';

const PKG_NAME = JSON.parse(
  (await import('node:fs')).readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).name as string;
const posix = (p: string) => p.replace(/\\/g, '/');

const PROFILE = (home: string) => `schemaVersion: 1
identities:
  work:
    user:
      name: Alex Chen
      email: alex@company.example
    sites:
      - host: git.company.example
      - host: git.shared.example
  personal:
    user:
      name: alex
      email: alex@personal.example
    sshKey: id_personal
    sites:
      - host: github.com
        alias: gh
rules:
  - dir: ${posix(home)}/code/work
    identity: work
  - dir: ${posix(home)}/code/personal
    identity: personal
settings:
  backupKeep: 5
`;

interface Ctx {
  h: TmpHome;
  server: RunningServer;
  base: string;
  token: string;
  get: (endpoint: string) => Promise<Response>;
  post: (endpoint: string, body?: unknown) => Promise<Response>;
}

async function withServer(fn: (ctx: Ctx) => Promise<void>, profile?: string): Promise<void> {
  const h = await createTmpHome('gs-api-');
  let server: RunningServer | undefined;
  try {
    await h.write('.gitconfig', '[user]\n\tname = global\n\temail = global@example.com\n');
    await h.write('.ssh/id_personal', '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n');
    if (profile !== NO_PROFILE) await h.write('.config/gs/profiles.yaml', profile ?? PROFILE(h.home));
    await mkdir(path.join(h.home, 'code', 'work'), { recursive: true });
    await mkdir(path.join(h.home, 'code', 'personal'), { recursive: true });
    server = await startServer({ home: h.home });
    const base = `http://127.0.0.1:${server.port}`;
    const auth = { 'x-gs-token': server.token };
    await fn({
      h,
      server,
      base,
      token: server.token,
      get: (endpoint) => fetch(`${base}${endpoint}`, { headers: auth }),
      post: (endpoint, body) =>
        fetch(`${base}${endpoint}`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        }),
    });
  } finally {
    if (server) await server.close();
    await h.cleanup();
  }
}

const NO_PROFILE = Symbol('no-profile') as unknown as string;

/* ================================================================== */
/* /api/state                                                          */
/* ================================================================== */

test('api: state reports the profile summary the UI renders', async () => {
  await withServer(async ({ h, get }) => {
    const res = await get('/api/state');
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      home: string;
      homePath: string;
      isSandbox: boolean;
      profileExists: boolean;
      identities: { name: string; email: string; userName: string; sshKey: string | null; sites: { host: string }[] }[];
      rules: { dir: string; identity: string }[];
      repositories: unknown[];
      profileError?: string;
    };
    assert.equal(body.home, '~');
    assert.equal(body.homePath, posix(h.home));
    assert.equal(body.isSandbox, true, 'a tmp home must be reported as a sandbox');
    assert.equal(body.profileExists, true);
    assert.equal(body.profileError, undefined);
    assert.deepEqual(
      body.identities.map((i) => i.name),
      ['work', 'personal'],
    );
    const personal = body.identities.find((i) => i.name === 'personal');
    assert.equal(personal?.sshKey, 'id_personal');
    assert.deepEqual(
      personal?.sites.map((s) => s.host),
      ['github.com'],
    );
    assert.equal(body.rules.length, 2);
    assert.equal(body.repositories.length, 0);
  });
});

test('api: state resolves an identity for a directory under a rule', async () => {
  await withServer(async ({ h, get }) => {
    const inside = await (await get(`/api/state?dir=${encodeURIComponent(`${h.home}/code/work/repo`) }`)).json();
    const body = inside as { resolved?: { identity: string; reason: string } };
    assert.equal(body.resolved?.identity, 'work');
    assert.equal(body.resolved?.reason, 'rule');

    const outside = await (await get(`/api/state?dir=${encodeURIComponent(`${h.home}/elsewhere`)}`)).json();
    assert.equal((outside as { resolved?: unknown }).resolved, undefined);
  });
});

test('api: state on a missing profile is 200 with an empty summary', async () => {
  await withServer(
    async ({ get }) => {
      const res = await get('/api/state');
      assert.equal(res.status, 200);
      const body = (await res.json()) as { profileExists: boolean; profileError?: string; identities: unknown[] };
      assert.equal(body.profileExists, false);
      assert.equal(body.identities.length, 0, 'no identities may be invented');
      assert.ok(body.profileError, 'the reason must be reported so init can be offered');
    },
    NO_PROFILE,
  );
});

/* ================================================================== */
/* /api/plan and /api/apply                                            */
/* ================================================================== */

test('api: a damaged profile is reported by plan, not turned into a 500', async () => {
  await withServer(async ({ h, get, post }) => {
    await h.write('.config/gs/profiles.yaml', 'schemaVersion: 1\nidentities: {}\n');
    const state = (await (await get('/api/state')).json()) as { profileError?: string; identities: unknown[] };
    assert.ok(state.profileError);
    assert.deepEqual(state.identities, []);

    const plan = await post('/api/plan', {});
    assert.ok(plan.status < 500, `plan returned ${plan.status}`);
    await plan.text();
  }, 'schemaVersion: 1\nidentities: {}\n');
});

test('api: plan body profilesText overrides the file without touching disk', async () => {
  await withServer(async ({ h, post }) => {
    const before = await h.read('.config/gs/profiles.yaml');
    const draft = `schemaVersion: 1
identities:
  draft:
    user:
      name: Draft
      email: draft@example.com
    sshKey: id_personal
rules:
  - dir: ${posix(h.home)}/code/work
    identity: draft
`;
    const res = await post('/api/plan', { profilesText: draft });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { dirty: boolean; files: { label: string; diff: string }[] };
    assert.ok(body.files.length > 0);
    assert.equal(await h.read('.config/gs/profiles.yaml'), before, 'planning a draft must not persist it');
  });
});

test('api: apply is idempotent and never rewrites an unchanged file twice', async () => {
  await withServer(async ({ h, post }) => {
    const first = (await (await post('/api/apply')).json()) as { written: string[]; errors: unknown[] };
    assert.equal(first.errors.length, 0);
    assert.ok(first.written.length >= 2);

    const gitconfigAfterFirst = await h.read('.gitconfig');
    const second = (await (await post('/api/apply')).json()) as { written: string[]; dirty: boolean };
    assert.deepEqual(second.written, [], 'a second apply must be a no-op');
    assert.equal(second.dirty, false);
    assert.equal(await h.read('.gitconfig'), gitconfigAfterFirst);
  });
});

test('api: apply preserves CRLF line endings and the user\'s own gitconfig content', async () => {
  await withServer(async ({ h, post }) => {
    await h.write('.gitconfig', '[user]\r\n\tname = keep\r\n\temail = keep@example.com\r\n');
    const res = await post('/api/apply');
    assert.equal(res.status, 200);
    const text = await h.read('.gitconfig');
    assert.ok(text.includes('[user]\r\n\tname = keep\r\n'), 'the user\'s own section must survive byte for byte');
    assert.ok(text.includes('gs:managed'));
    assert.ok(!/[^\r]\n/.test(text.replace(/\r\n/g, '\r\n')), 'no bare LF may be introduced into a CRLF file');
  });
});

test('api: apply overwrites a managed block edited after planning', async () => {
  await withServer(async ({ h, post }) => {
    assert.equal((await post('/api/apply')).status, 200);
    const text = await h.read('.gitconfig');
    // `plan` normalises the trailing newline of the block body, so an edit that
    // only appends blank lines does not change the desired output — append a real
    // line instead so the plan genuinely has to rewrite the file.
    const edited = text.replace('gs:managed >>>', 'gs:managed >>>\n# hand edit');
    assert.notEqual(edited, text, 'the fixture must actually change the file');
    await h.write('.gitconfig', edited);

    const plan = (await (await post('/api/plan')).json()) as { dirty: boolean; warnings: string[] };
    assert.equal(plan.dirty, true, 'the hand edit must make the file differ from the generated block');

    // `apply()` promises: "Refuse to overwrite a managed block that was edited by
    // hand after the plan was computed (the user's edit would be silently
    // destroyed)." The block was computed from the *edited* file, so the note the
    // user wrote inside it is dropped without a word.
    const applied = await post('/api/apply');
    const body = (await applied.json()) as { written?: string[]; error?: string };
    const after = await h.read('.gitconfig');
    assert.ok(
      after.includes('# hand edit'),
      `applying silently deleted a hand edit from the managed block ` +
        `(status ${applied.status}, written ${JSON.stringify(body.written ?? body.error)})`,
    );
    void plan;
  });
});

/* ================================================================== */
/* /api/doctor                                                         */
/* ================================================================== */

test('api: doctor counts errors and warnings and never goes online by default', async () => {
  await withServer(async ({ get }) => {
    const res = await get('/api/doctor');
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      results: { id: string; level: string; title: string }[];
      errors: number;
      warnings: number;
    };
    assert.equal(body.errors, body.results.filter((r) => r.level === 'error').length);
    assert.equal(body.warnings, body.results.filter((r) => r.level === 'warn').length);
    assert.ok(body.results.some((r) => r.id === 'profile' && r.level === 'ok'), 'the profile itself must load');
    assert.ok(body.results.some((r) => r.id === 'key:id_personal'), 'the key on disk is inspected');
    assert.ok(!JSON.stringify(body).includes('PRIVATE KEY'), 'doctor output must not embed key material');
  });
});

test('api: doctor reports an identity with no key as a warning, not an error', async () => {
  await withServer(async ({ get }) => {
    const body = (await (await get('/api/doctor')).json()) as { results: { id: string; level: string; title: string }[] };
    const keyless = body.results.find((r) => r.id === 'key:work');
    assert.ok(keyless, 'a keyless identity is reported');
    assert.equal(keyless.level, 'warn');
  });
});

/* ================================================================== */
/* /api/fs                                                             */
/* ================================================================== */

test('api: fs browse defaults to home and marks repositories', async () => {
  await withServer(async ({ h, get }) => {
    await mkdir(path.join(h.home, 'proj', 'repo', '.git'), { recursive: true });
    await mkdir(path.join(h.home, 'proj', '.hidden'), { recursive: true });
    await mkdir(path.join(h.home, 'proj', 'node_modules'), { recursive: true });
    const res = await get(`/api/fs?dir=${encodeURIComponent(path.join(h.home, 'proj'))}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { dir: string; entries: { name: string; isRepo: boolean }[]; roots: string[] };
    assert.equal(body.dir, posix(path.join(h.home, 'proj')));
    assert.deepEqual(
      body.entries.map((e) => e.name),
      ['repo'],
      'dot directories and node_modules are not offered, repos sort first',
    );
    assert.equal(body.entries[0]?.isRepo, true);
    assert.ok(body.roots.length >= 1);
  });
});

test('api: fs browse without a dir parameter lists home', async () => {
  await withServer(async ({ h, get }) => {
    const res = await get('/api/fs');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { dir: string; entries: { name: string }[] };
    assert.equal(body.dir, posix(h.home));
    assert.ok(body.entries.some((e) => e.name === 'code'));
  });
});

test('api: fs browse reports a missing directory as an error, not a crash', async () => {
  await withServer(async ({ h, get }) => {
    const res = await get(`/api/fs?dir=${encodeURIComponent(path.join(h.home, 'nope'))}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { error?: string; entries: unknown[] };
    assert.ok(body.error);
    assert.deepEqual(body.entries, []);
  });
});

/* ================================================================== */
/* /api/rules and /api/identities                                      */
/* ================================================================== */

test('api: rules add, replace and remove round-trip through the file', async () => {
  await withServer(async ({ h, post }) => {
    const target = `${posix(h.home)}/code/work/sub`;
    const added = (await (await post('/api/rules', { add: true, dir: target, identity: 'personal' })).json()) as {
      rules: { dir: string; identity: string }[];
    };
    assert.ok(added.rules.some((r) => r.dir === target && r.identity === 'personal'));
    assert.ok((await h.read('.config/gs/profiles.yaml')).includes('code/work/sub'));

    const removed = (await (await post('/api/rules', { remove: target })).json()) as { rules: { dir: string }[] };
    assert.equal(removed.rules.some((r) => r.dir === target), false);
    assert.ok(!(await h.read('.config/gs/profiles.yaml')).includes('code/work/sub'));
  });
});

test('api: rules reject an unknown identity and a malformed request', async () => {
  await withServer(async ({ post }) => {
    assert.equal((await post('/api/rules', { add: true, dir: '/x', identity: 'ghost' })).status, 400);
    assert.equal((await post('/api/rules', { add: true, dir: '/x' })).status, 400);
    assert.equal((await post('/api/rules', { remove: undefined })).status, 400);
    assert.equal((await post('/api/rules', {})).status, 400);
  });
});

test('api: identities add/update/remove keeps rules and sites consistent', async () => {
  await withServer(async ({ h, post }) => {
    const added = await post('/api/identities', {
      add: true,
      name: 'third',
      userName: 'Third',
      email: 'third@example.com',
      host: 'git.third.example',
      port: 2222,
    });
    assert.equal(added.status, 200);
    const addedBody = (await added.json()) as { identities: { name: string; sites: { host: string; port: number | null } }[] };
    const third = addedBody.identities.find((i) => i.name === 'third');
    assert.deepEqual(third?.sites, [{ host: 'git.third.example', port: 2222, alias: null }]);

    // rename must rewrite the rules that point at it
    await post('/api/rules', { add: true, dir: `${posix(h.home)}/code/third`, identity: 'third' });
    const renamed = await post('/api/identities', { update: true, original: 'third', name: 'renamed', userName: 'R', email: 'r@example.com' });
    assert.equal(renamed.status, 200);
    const renamedBody = (await renamed.json()) as { rules: { dir: string; identity: string }[]; identities: { name: string }[] };
    assert.ok(renamedBody.identities.some((i) => i.name === 'renamed'));
    assert.ok(renamedBody.rules.some((r) => r.dir.endsWith('/code/third') && r.identity === 'renamed'));

    // the file must still load
    const state = (await (await post('/api/state')).json()) as { profileError?: string };
    assert.equal(state.profileError, undefined);
    assert.ok((await h.read('.config/gs/profiles.yaml')).includes('renamed'));
  });
});

test('api: removing an identity in use needs force, and the last identity is protected', async () => {
  await withServer(async ({ post }) => {
    const inUse = await post('/api/identities?remove=work');
    assert.equal(inUse.status, 409);
    const body = (await inUse.json()) as { rules: number };
    assert.equal(body.rules, 1);

    assert.equal((await post('/api/identities?remove=work&force=1')).status, 200);

    // now only `personal` is left
    const last = await post('/api/identities?remove=personal');
    assert.equal(last.status, 409);
    const lastBody = (await last.json()) as { lastIdentity: boolean };
    assert.equal(lastBody.lastIdentity, true);
  });
});

test('api: an invalid site port is rejected without leaving a half-written identity', async () => {
  await withServer(async ({ h, post }) => {
    const before = await h.read('.config/gs/profiles.yaml');
    for (const port of [0, -1, 70000, 'abc']) {
      const res = await post('/api/identities', {
        add: true,
        name: `p${String(port).replace(/\W/g, '')}`,
        userName: 'x',
        email: 'x@example.com',
        host: 'git.example.com',
        port,
      });
      assert.equal(res.status, 400, `port ${String(port)} must be rejected`);
    }
    assert.equal(await h.read('.config/gs/profiles.yaml'), before);
  });
});

/* ================================================================== */
/* /api/global-identity                                                */
/* ================================================================== */

test('api: global identity writes only the [user] section', async () => {
  await withServer(async ({ h, post }) => {
    // Two CRLF files in a row: the first request must learn the file's line
    // endings from the file itself, not from whatever the previous request saw.
    await h.write('.gitconfig', '[core]\r\n\tautocrlf = true\r\n\r\n[user]\r\n\tname = old\r\n\temail = old@example.com\r\n\r\n[alias]\r\n\tco = checkout\r\n');
    const res = await post('/api/global-identity', { name: 'New', email: 'new@example.com' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { before: string | null; after: string };
    assert.equal(body.before, 'old <old@example.com>');
    assert.equal(body.after, 'New <new@example.com>');
    const text = await h.read('.gitconfig');
    assert.ok(text.includes('[core]') && text.includes('co = checkout'), 'other sections must be preserved');
    assert.ok(text.includes('New') && text.includes('new@example.com'));
    assert.ok(!/[^\r]\n/.test(text), `CRLF must survive the edit, got ${JSON.stringify(text)}`);

    // A second edit, immediately after, must keep CRLF as well.
    const second = await post('/api/global-identity', { name: 'Again', email: 'again@example.com' });
    assert.equal(second.status, 200);
    const again = await h.read('.gitconfig');
    assert.ok(!/[^\r]\n/.test(again), `CRLF must survive the second edit, got ${JSON.stringify(again)}`);
  });
});

test('api: global identity validates the email', async () => {
  await withServer(async ({ h, post }) => {
    const before = await h.read('.gitconfig');
    for (const body of [{ name: '', email: 'x@example.com' }, { name: 'x', email: '' }, { name: 'x', email: 'nope' }]) {
      const res = await post('/api/global-identity', body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(await h.read('.gitconfig'), before);
  });
});

/* ================================================================== */
/* /api/keys                                                           */
/* ================================================================== */

test('api: keys lists names and usage but never key material', async () => {
  await withServer(async ({ get }) => {
    const res = await get('/api/keys');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { keys: { name: string; usedBy: string[] }[] };
    const personal = body.keys.find((k) => k.name === 'id_personal');
    assert.ok(personal, 'the private key must be listed');
    assert.deepEqual(personal.usedBy, ['personal'], 'the identity that references it is named');
    assert.ok(!JSON.stringify(body).includes('fake'), 'key material must never be returned');
  });
});

test('api: keys rejects unknown actions and unsafe names', async () => {
  await withServer(async ({ post }) => {
    assert.equal((await post('/api/keys', { action: 'delete', name: 'id_personal' })).status, 400);
    assert.equal((await post('/api/keys', { action: 'copy' })).status, 400);
    assert.equal((await post('/api/keys', { action: 'copy', name: '../../.gitconfig' })).status, 400);
    assert.equal((await post('/api/keys', { action: 'rename', name: 'a', newName: '../b' })).status, 400);
    assert.equal((await post('/api/keys', { action: 'generate', name: '/' })).status, 400);
    assert.equal((await post('/api/keys', { action: 'restore' })).status, 400);
  });
});

/* ================================================================== */
/* /api/snapshot/*                                                     */
/* ================================================================== */

test('api: snapshot export/import round-trips a profile', async () => {
  await withServer(async ({ h, post }) => {
    const exported = await post('/api/snapshot/export', { path: 'round.gsnap' });
    assert.equal(exported.status, 200);
    const body = (await exported.json()) as { path: string; files: number; identities: number; rules: number };
    assert.equal(body.path, path.join(h.home, 'round.gsnap'));
    assert.equal(body.identities, 2);
    assert.equal(body.rules, 2);

    await h.write('.config/gs/profiles.yaml', `${PROFILE(h.home).replace('git.company.example', 'changed.example')}`);
    const imported = await post('/api/snapshot/import', { path: 'round.gsnap' });
    assert.equal(imported.status, 200);
    assert.ok((await h.read('.config/gs/profiles.yaml')).includes('git.company.example'));
  });
});

test('api: snapshot export defaults to the snapshot directory and refuses to overwrite', async () => {
  await withServer(async ({ h, post }) => {
    const first = (await (await post('/api/snapshot/export', {})).json()) as { path: string };
    assert.ok(first.path.startsWith(path.join(h.home, '.config', 'gs', 'snapshots')));
    const files = await readdir(path.dirname(first.path));
    assert.equal(files.length, 1);

    const explicit = await post('/api/snapshot/export', { path: 'explicit.gsnap' });
    assert.equal(explicit.status, 200);
    const again = await post('/api/snapshot/export', { path: 'explicit.gsnap' });
    assert.equal(again.status, 409);
    const forced = await post('/api/snapshot/export', { path: 'explicit.gsnap', force: true });
    assert.equal(forced.status, 200);
  });
});

test('api: snapshot import rejects a bad remap and leaves the profile alone', async () => {
  await withServer(async ({ h, post }) => {
    assert.equal((await post('/api/snapshot/export', { path: 'r.gsnap' })).status, 200);
    const before = await h.read('.config/gs/profiles.yaml');
    const res = await post('/api/snapshot/import', { path: 'r.gsnap', remaps: 'nonsense' });
    assert.equal(res.status, 400);
    assert.equal(await h.read('.config/gs/profiles.yaml'), before);
  });
});

/* ================================================================== */
/* /api/init/*                                                         */
/* ================================================================== */

test('api: init scan and apply create a usable profile in an empty home', async () => {
  await withServer(
    async ({ h, get, post }) => {
      const scan = await post('/api/init/scan', { root: 'code', offline: true });
      assert.equal(scan.status, 200);
      const scanBody = (await scan.json()) as { identities: { name: string }[]; rules: unknown[]; warnings: string[] };
      assert.ok(Array.isArray(scanBody.identities));
      assert.ok(Array.isArray(scanBody.warnings));
      assert.equal(await h.exists('.config/gs/profiles.yaml'), false, 'scanning must not write');

      const applied = await post('/api/init/apply', { root: 'code', offline: true });
      assert.equal(applied.status, 200);
      assert.equal(await h.exists('.config/gs/profiles.yaml'), true);
      const state = (await (await get('/api/state')).json()) as { profileError?: string; profileExists: boolean };
      assert.equal(state.profileExists, true);
      assert.equal(state.profileError, undefined, `init wrote an unloadable profile: ${state.profileError}`);
    },
    NO_PROFILE,
  );
});

test('api: init apply refuses to overwrite an existing profile without force', async () => {
  await withServer(async ({ h, post }) => {
    const before = await h.read('.config/gs/profiles.yaml');
    const res = await post('/api/init/apply', {});
    assert.equal(res.status, 409);
    assert.equal(await h.read('.config/gs/profiles.yaml'), before);
  });
});

/* ================================================================== */
/* /api/repair                                                         */
/* ================================================================== */

test('api: repair reports a fixable host and optionally applies it', async () => {
  const broken = (home: string) => `schemaVersion: 1
identities:
  work:
    user:
      name: w
      email: w@example.com
    sites:
      - host: http://git.company.example/
rules:
  - dir: ${posix(home)}/code/work
    identity: work
`;
  await withServer(async ({ h, post }) => {
    const dry = await post('/api/repair', { apply: false });
    assert.equal(dry.status, 200);
    const dryBody = (await dry.json()) as { ok: boolean; dryRun: boolean; suggestion: { fixed: string } };
    assert.equal(dryBody.ok, false);
    assert.equal(dryBody.dryRun, true);
    assert.equal(dryBody.suggestion.fixed, 'git.company.example');
    assert.equal((await h.read('.config/gs/profiles.yaml')).includes('http://'), true, 'a dry run writes nothing');

    const applied = await post('/api/repair', { apply: true });
    assert.equal(applied.status, 200);
    const appliedBody = (await applied.json()) as { ok: boolean; backup: string };
    assert.equal(appliedBody.ok, true);
    assert.equal(posix(appliedBody.backup), posix(path.join(h.home, '.config/gs/profiles.yaml.before-repair')));
    assert.equal(await h.exists('.config/gs/profiles.yaml.before-repair'), true, 'the pre-repair copy is kept');
    assert.ok((await h.read('.config/gs/profiles.yaml')).includes('host: git.company.example'));
  }, broken(process.cwd()));
});

test('api: repair on a valid profile is a no-op', async () => {
  await withServer(async ({ h, post }) => {
    const before = await h.read('.config/gs/profiles.yaml');
    const res = await post('/api/repair', { apply: true });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; alreadyValid: boolean };
    assert.equal(body.alreadyValid, true);
    assert.equal(await h.read('.config/gs/profiles.yaml'), before);
  });
});

/* ================================================================== */
/* /api/version                                                        */
/* ================================================================== */

test('api: version matches the CLI report shape', async () => {
  await withServer(async ({ get }) => {
    const res = await get('/api/version');
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(typeof body.version, 'string');
    assert.equal(body.name, PKG_NAME);
    assert.equal(typeof body.license, 'string');
    assert.ok(['dev', 'stable', 'prerelease'].includes(String(body.channel)), `unexpected channel ${String(body.channel)}`);
    assert.ok(!('token' in body));
  });
});

/* ================================================================== */
/* concurrency                                                         */
/* ================================================================== */

test('api: concurrent writes to profiles.yaml are serialised', async () => {
  await withServer(async ({ h, post }) => {
    const dirs = Array.from({ length: 8 }, (_, i) => path.join(h.home, 'burst', `d${i}`));
    for (const dir of dirs) await mkdir(dir, { recursive: true });

    // Read-modify-write with no lock: every request loads the profile, mutates its
    // own copy and saves. Two outcomes are bugs — a request failing outright
    // ("permission denied" from racing renames on the same temp path), and a
    // request answering 200 while its change is later overwritten (lost update).
    const responses = await Promise.all(
      dirs.map((dir) => post('/api/rules', { add: true, dir: posix(dir), identity: 'work' })),
    );
    const statuses = responses.map((r) => r.status);
    const bodies = await Promise.all(responses.map((r) => r.text()));

    const failures = statuses
      .map((status, i) => (status === 200 ? '' : `#${i}=${status} ${bodies[i]?.slice(0, 100)}`))
      .filter(Boolean);
    const text = await h.read('.config/gs/profiles.yaml');
    const onDisk = (text.match(/dir:/g) ?? []).length;
    assert.ok(failures.length === 0, `concurrent adds must not fail: ${failures.join(' | ')}`);
    assert.equal(onDisk, 2 + dirs.length, `all rules must be persisted; file has ${onDisk} of ${2 + dirs.length}`);

    const leftovers = (await readdir(path.join(h.home, '.config', 'gs'))).filter((n) => n.includes('gs-tmp-'));
    assert.deepEqual(leftovers, [], 'no atomic-write temp file may be left behind');

    const state = (await (await post('/api/state')).json()) as { profileError?: string };
    assert.equal(state.profileError, undefined, 'the file must still be loadable after the burst');
  });
});

test('api: concurrent apply requests do not corrupt the managed block', async () => {
  await withServer(async ({ h, post }) => {
    const responses = await Promise.all(Array.from({ length: 4 }, () => post('/api/apply')));
    const bodies = await Promise.all(responses.map((r) => r.text()));
    for (const [index, res] of responses.entries()) {
      assert.ok(res.status === 200 || res.status === 400, `apply #${index} returned ${res.status}: ${bodies[index]?.slice(0, 120)}`);
    }
    const gitconfig = await h.read('.gitconfig');
    const begins = gitconfig.split('gs:managed >>>').length - 1;
    const ends = gitconfig.split('gs:managed <<<').length - 1;
    assert.equal(begins, 1, 'exactly one managed block must remain');
    assert.equal(ends, 1);
    const state = (await (await post('/api/plan')).json()) as { errors: string[] };
    assert.deepEqual(state.errors, [], 'the file must still be a valid gitconfig for gs');
  });
});

test('api: concurrent writes never lose an accepted edit', async () => {
  await withServer(async ({ h, get, post }) => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    const responses = await Promise.all(
      names.map((name) =>
        post('/api/identities', { add: true, name: `race-${name}`, userName: name, email: `${name}@example.com` }),
      ),
    );
    const statuses = responses.map((r) => r.status);
    const bodies = await Promise.all(responses.map((r) => r.text()));

    const state = (await (await get('/api/state')).json()) as {
      profileError?: string;
      identities?: { name: string }[];
    };
    const persisted = (state.identities ?? []).map((i) => i.name).filter((n) => n.startsWith('race-'));
    // Each handler read the file, added its identity to its own copy and saved;
    // whoever saves last wins. Every other 200 was a lie about what is on disk.
    const accepted = names.filter((_, i) => statuses[i] === 200);
    assert.deepEqual(
      persisted,
      accepted.map((n) => `race-${n}`),
      `every accepted edit must be persisted: accepted ${accepted.join(',') || 'none'}, ` +
        `on disk ${persisted.join(',') || 'none'} (statuses ${statuses.join(',')} ` +
        `failures ${bodies.filter((_, i) => statuses[i] !== 200).join(' | ').slice(0, 160)})`,
    );
    void h;
  });
});
