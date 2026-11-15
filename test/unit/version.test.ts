import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { composeVersion, readPackageMeta, versionReport, type BuildInfo } from '../../src/core/version.ts';
const PKG_NAME = JSON.parse(
  (await import('node:fs')).readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).name as string;

/**
 * `gs version` answers "which release, who wrote it, which commit".
 *
 * The version string carries git build metadata (`0.1.0+362.g8b4f2c1`) so two
 * builds of the same commit are indistinguishable while two different commits are
 * not. The same commit must always produce the same string — a timestamp in the
 * version would break that, which is why it lives in `builtAt` instead.
 */

const BASE: BuildInfo = {
  version: '',
  commitCount: 42,
  commit: 'abc1234',
  dirty: false,
  builtAt: '2026-01-01T00:00:00.000Z',
  channel: 'release',
};

test('composeVersion appends commit metadata', () => {
  assert.equal(composeVersion('0.1.0', BASE), '0.1.0+42.gabc1234');
});

test('composeVersion marks a dirty tree', () => {
  assert.equal(composeVersion('0.1.0', { ...BASE, dirty: true }), '0.1.0+42.gabc1234.dirty');
});

test('composeVersion stays valid SemVer without git information', () => {
  const { commitCount: _count, commit: _commit, ...withoutGit } = BASE;
  assert.equal(composeVersion('0.1.0', withoutGit), '0.1.0');
});

test('composeVersion reports dev builds distinctly', () => {
  assert.equal(composeVersion('0.1.0', { ...BASE, channel: 'dev' }), '0.1.0+dev');
});

test('the same commit produces the same version', () => {
  // reproducibility: nothing in the version may depend on the wall clock
  const first = composeVersion('0.1.0', { ...BASE, builtAt: '2026-01-01T00:00:00.000Z' });
  const second = composeVersion('0.1.0', { ...BASE, builtAt: '2026-06-01T00:00:00.000Z' });
  assert.equal(first, second);
});

test('package metadata exposes author, licence and repository', async () => {
  const meta = readPackageMeta();
  assert.equal(meta.name, PKG_NAME);
  assert.match(meta.version, /^\d+\.\d+\.\d+/);
  assert.equal(meta.license, 'MIT');
  assert.ok(meta.author && meta.author.length > 0, 'author is set');
  assert.match(meta.repository ?? '', /^https:\/\//);
  assert.ok(!(meta.repository ?? '').startsWith('git+'), 'the git+ prefix is stripped');
});

test('a string author is normalised to a name', async () => {
  const h = await createTmpHome();
  try {
    await mkdir(path.join(h.home, 'pkg'), { recursive: true });
    await writeFile(
      path.join(h.home, 'pkg', 'package.json'),
      JSON.stringify({ name: 'x', version: '1.2.3', author: 'Jane Doe <jane@example.com> (https://jane.dev)' }),
      'utf8',
    );
    const meta = readPackageMeta(path.join(h.home, 'pkg'));
    assert.equal(meta.author, 'Jane Doe');
    assert.equal(meta.version, '1.2.3');
  } finally {
    await h.cleanup();
  }
});

test('the active report is coherent', () => {
  const report = versionReport();
  assert.equal(report.version, report.build.version);
  assert.ok(report.package.name.length > 0);

  // every reported version is either a release with metadata or an explicit dev build
  if (report.build.channel === 'dev') {
    assert.match(report.version, /\+dev$/);
  } else {
    assert.doesNotMatch(report.version, /\+dev$/);
  }
});
