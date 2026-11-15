import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

/**
 * Regression guard for the defect that made an installed package unusable:
 * Node refuses to strip types inside node_modules, so dist must contain real
 * JavaScript. These tests build the package and inspect the emitted files.
 */

test('the build emits JavaScript, not TypeScript, so node_modules works', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'gs-publish-'));
  try {
    // build in place is fine: dist is gitignored and rebuilt on demand
    await run(process.execPath, [path.join(repoRoot, 'scripts', 'build.mjs')]);

    const dist = path.join(repoRoot, 'dist');
    const cli = path.join(dist, 'cli.js');
    const info = await stat(cli).catch(() => undefined);
    assert.ok(info, 'dist/cli.js must exist (plain JavaScript)');

    const tsFiles = await import('node:fs/promises').then((fs) => fs.readdir(dist)).catch(() => []);
    assert.ok(
      !tsFiles.some((f: string) => f.endsWith('.ts')),
      `dist must not contain TypeScript sources, found: ${tsFiles.filter((f: string) => f.endsWith('.ts')).join(', ')}`,
    );

    const source = await readFile(cli, 'utf8');
    // a type annotation left behind would mean the compiler did not run
    assert.ok(!source.includes('interface Job\n'), 'no interface declarations in emitted JS');
    assert.ok(!/:\s*Promise<[^>]+>\s*=>/.test(source), 'no generic return annotations in emitted JS');

    // the launcher must point at the compiled entry point
    const launcher = await readFile(path.join(dist, 'gs.mjs'), 'utf8');
    assert.match(launcher, /from '\.\/cli\.js'/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('the compiled CLI is executable and reports its version', async () => {
  const { stdout } = await run(process.execPath, [path.join(repoRoot, 'dist', 'gs.mjs'), 'version'], {
    cwd: tmpdir(),
  });
  // the first line stays the bare version; build metadata (`+27.gabc1234`) is legal
  // SemVer and expected from a compiled build
  const first = stdout.trim().split('\n')[0] ?? '';
  assert.match(first, /^\d+\.\d+\.\d+(\+[0-9A-Za-z.-]+)?$/);
});

test('the compiled build records which commit produced it', async () => {
  const info = JSON.parse(await readFile(path.join(repoRoot, 'dist', 'build-info.json'), 'utf8')) as {
    version: string;
    channel: string;
    builtAt: string;
    commit?: string;
  };
  assert.equal(info.channel, 'release', 'a compiled build is a release build');
  assert.match(info.version, /^\d+\.\d+\.\d+/);
  assert.ok(info.builtAt.length > 0);
  assert.ok(info.commit === undefined || /^[0-9a-f]{7,}$/.test(info.commit), 'the commit is a short hash');
});

test('running from sources reports a dev build', async () => {
  const { stdout } = await run(
    process.execPath,
    [path.join(repoRoot, 'src', 'cli.ts'), 'version', '--short'],
    { cwd: tmpdir() },
  );
  assert.match(stdout.trim(), /\+dev$/, 'sources without a build step say so');
});

test('the compiled build serves the GUI assets', async () => {
  const dist = path.join(repoRoot, 'dist');
  const index = await stat(path.join(dist, 'web', 'index.html')).catch(() => undefined);
  assert.ok(index?.isFile(), 'dist/web/index.html must be published');
  for (const asset of ['src/main.js', 'src/api.js', 'src/styles/main.css']) {
    const info = await stat(path.join(dist, 'web', asset)).catch(() => undefined);
    assert.ok(info?.isFile(), `dist/web/${asset} must be published`);
  }
});

test('package.json keeps runtime dependencies empty and ships dist', async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    files: string[];
    bin: Record<string, string>;
  };
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, 'no runtime dependencies');
  assert.ok(pkg.devDependencies?.typescript, 'typescript is a devDependency for the build');
  assert.ok(pkg.files.includes('dist'));
  assert.equal(pkg.bin.gs, 'dist/gs.mjs');
});
