import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { startServer } from '../../src/server/http.ts';
import { versionReport } from '../../src/core/version.ts';

const PKG_NAME = JSON.parse(
  (await import('node:fs')).readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).name as string;
const run = promisify(execFile);

/**
 * The GUI must be able to answer "which build is this?", the same question
 * `gs version` answers on the command line.
 *
 * Before this endpoint existed, the CLI reported a version and the browser could
 * not: the two surfaces had drifted, and the build tag was the only visible
 * difference between them.
 */

interface VersionPayload {
  version: string;
  name: string;
  author: string | null;
  license: string | null;
  repository: string | null;
  commit: string | null;
  commitCount: number | null;
  builtAt: string;
  channel: string;
  dirty: boolean;
}

async function withServer(fn: (base: string, token: string) => Promise<void>) {
  const h = await createTmpHome();
  try {
    await mkdir(path.join(h.home, '.config', 'gs'), { recursive: true });
    await writeFile(
      path.join(h.home, '.config', 'gs', 'profiles.yaml'),
      'schemaVersion: 1\nidentities:\n  a:\n    user: { name: a, email: a@example.com }\nrules: []\n',
      'utf8',
    );
    await writeFile(path.join(h.home, '.gitconfig'), '', 'utf8');
    const server = await startServer({ home: h.home });
    try {
      await fn(`http://127.0.0.1:${server.port}`, server.token);
    } finally {
      await server.close();
    }
  } finally {
    await h.cleanup();
  }
}

test('GET /api/version reports the running build', async () => {
  await withServer(async (base, token) => {
    const res = await fetch(`${base}/api/version`, { headers: { 'x-gs-token': token } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as VersionPayload;

    assert.match(body.version, /^\d+\.\d+\.\d+/, 'a semver version');
    assert.equal(body.name, PKG_NAME);
    assert.equal(body.license, 'MIT');
    assert.ok(body.author, 'the author is exposed');
    assert.ok(body.repository?.startsWith('https://'), 'the repository is a browsable url');
    assert.ok(['release', 'dev'].includes(body.channel));
    assert.ok(body.builtAt.length > 0);
  });
});

test('the web reports exactly what the CLI reports', async () => {
  await withServer(async (base, token) => {
    const web = (await (
      await fetch(`${base}/api/version`, { headers: { 'x-gs-token': token } })
    ).json()) as VersionPayload;

    const report = versionReport();
    assert.equal(web.version, report.version, 'the two surfaces agree');
    assert.equal(web.author, report.package.author ?? null);
    assert.equal(web.commit, report.build.commit ?? null);
    assert.equal(web.channel, report.build.channel);
  });
});

test('the CLI prints the same version the API serves', async () => {
  const { stdout } = await run(process.execPath, [path.resolve('src/cli.ts'), 'version', '--json'], {
    windowsHide: true,
  });
  const cli = JSON.parse(stdout) as { version: string; package: { author?: string } };

  await withServer(async (base, token) => {
    const web = (await (
      await fetch(`${base}/api/version`, { headers: { 'x-gs-token': token } })
    ).json()) as VersionPayload;
    assert.equal(web.version, cli.version, 'CLI and API must not disagree');
    assert.equal(web.author, cli.package.author ?? null);
  });
});

test('the API requires a token like every other endpoint', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/version`);
    assert.equal(res.status, 401);
  });
});

test('the build info lives in a menu, not in the header row', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile('web/index.html', 'utf8');

  // a full version string is too wide to sit next to the tabs
  assert.match(html, /id="about-trigger"/, 'the header has a menu trigger');
  assert.match(html, /id="about-panel"/, 'and a panel for the details');
  assert.doesNotMatch(html, /id="version-tag"/, 'the wide inline tag is gone');

  // the panel starts closed so it cannot shift the layout on load
  const panelTag = /<div[^>]*id="about-panel"[^>]*>/.exec(html)?.[0] ?? '';
  assert.match(panelTag, /\bhidden\b/, 'the menu is closed initially');

  const main = await readFile('web/src/main.js', 'utf8');
  assert.match(main, /api\.version\(\)/, 'the menu is filled from the API');
  assert.match(main, /renderVersion/, 'the rendering is a named function');
});

test('the menu reflects the running build', async () => {
  const { readFile } = await import('node:fs/promises');
  const main = await readFile('web/src/main.js', 'utf8');

  // author, licence and repository must all reach the menu
  for (const field of ['info.author', 'info.license', 'info.repository', 'info.version']) {
    assert.ok(main.includes(field), `the menu shows ${field}`);
  }
  // and it must be dismissible without navigating away
  assert.match(main, /Escape/, 'Escape closes the menu');
});

test('the repository is rendered as a safe external link', async () => {
  const { readFile } = await import('node:fs/promises');
  const main = await readFile('web/src/main.js', 'utf8');

  // it must be an anchor on the repository line, not plain text
  assert.match(main, /line\(t\('version\.repository'\), info\.repository, 'link'\)/, 'the repository line is a link');
  assert.match(main, /el\('a', \{/, 'an anchor is created');

  // and that anchor must be hardened against tabnabbing
  assert.match(main, /rel: 'noopener noreferrer'/, 'rel stops the opened page reaching window.opener');
  assert.match(main, /target: '_blank'/, 'it opens in a new tab');
});

test('only http(s) urls become links', async () => {
  // A package.json repository field is data, not code: it must never produce a
  // clickable javascript: or file: url.
  const { readFile } = await import('node:fs/promises');
  const main = await readFile('web/src/main.js', 'utf8');

  assert.match(main, /function isHttpUrl/, 'the guard exists');
  assert.match(main, /url\.protocol === 'http:' \|\| url\.protocol === 'https:'/, 'only http and https pass');

  // exercise the guard against the payload shapes it has to reject
  const guard = (value: string): boolean => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  };
  assert.equal(guard('https://github.com/x/y'), true);
  assert.equal(guard('javascript:alert(1)'), false);
  assert.equal(guard('file:///etc/passwd'), false);
  assert.equal(guard('data:text/html,x'), false);
  assert.equal(guard('not a url'), false);
});
