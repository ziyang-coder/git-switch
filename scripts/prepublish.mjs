#!/usr/bin/env node
/**
 * Pre-publish checks.
 *
 * Publishing is one-way: a bad tarball stays on the registry forever and a
 * version number can never be reused. This script verifies the things that are
 * expensive to get wrong, then prints what `npm publish` will ship.
 *
 *   node scripts/prepublish.mjs          check everything
 *   node scripts/prepublish.mjs --pack   also build the tarball and install it
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  — ${detail}`}`);
  if (!ok) failures.push(name);
};

const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...options }).toString();

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

/* ---------------- identity ---------------- */

check('package name is scoped', pkg.name.startsWith('@'), pkg.name);
check('name is lower-case (npm rejects upper-case)', pkg.name === pkg.name.toLowerCase(), pkg.name);
check('version is valid semver', /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version), pkg.version);
check('private flag is not set', pkg.private !== true);
check('scoped publish is public', pkg.publishConfig?.access === 'public', JSON.stringify(pkg.publishConfig));
check(
  'publish targets the official registry, not a mirror',
  pkg.publishConfig?.registry?.includes('registry.npmjs.org') === true,
  String(pkg.publishConfig?.registry),
);

/* ---------------- package shape ---------------- */

check('has a description', typeof pkg.description === 'string' && pkg.description.length > 20);
check('has a licence', typeof pkg.license === 'string' && pkg.license !== '', String(pkg.license));
check('has a repository', typeof pkg.repository?.url === 'string', JSON.stringify(pkg.repository));
check('repository url has no credentials', !/@[^/]+\//.test(pkg.repository?.url ?? ''));

// `gs version` prints this URL and the npm page links to it, so a stale value is
// user-visible. Compare against the remote the code is actually pushed to.
let remoteUrl = '';
try {
  remoteUrl = run('git', ['remote', 'get-url', 'origin']).trim();
} catch {
  /* no remote: nothing to compare */
}
if (remoteUrl !== '') {
  /**
   * Reduce a git URL to `owner/repo`.
   *
   * The remote may be an SSH alias (`git@github:owner/repo.git`, where `github` is
   * a Host entry in ~/.ssh/config) or an https URL; only the trailing two path
   * segments identify the repository in both.
   */
  const ownerRepo = (url) => {
    const cleaned = url
      .replace(/^git\+/, '')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '');
    const afterHost = cleaned.replace(/^[a-z]+:\/\/[^/]+\//i, '').replace(/^git@[^:]+:/, '');
    return afterHost.toLowerCase();
  };
  check(
    'repository url matches git remote origin',
    ownerRepo(pkg.repository?.url ?? '') === ownerRepo(remoteUrl),
    `package.json says ${pkg.repository?.url}, origin is ${remoteUrl}`,
  );
}
check('declares a node engine', typeof pkg.engines?.node === 'string', JSON.stringify(pkg.engines));
check('bin points at the built launcher', pkg.bin?.gs === 'dist/gs.mjs', JSON.stringify(pkg.bin));

const runtimeDeps = Object.keys(pkg.dependencies ?? {});
check('zero runtime dependencies', runtimeDeps.length === 0, runtimeDeps.join(', '));

/* ---------------- built artefacts ---------------- */

const mustExist = [
  'dist/gs.mjs',
  'dist/cli.js',
  'dist/build-info.json',
  'dist/web/index.html',
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
];
for (const file of mustExist) {
  const info = await stat(path.join(root, file)).catch(() => undefined);
  check(`${file} exists`, info?.isFile() === true);
}

const launcher = await readFile(path.join(root, 'dist/gs.mjs'), 'utf8').catch(() => '');
check('launcher starts with a node shebang', launcher.startsWith('#!/usr/bin/env node'), launcher.slice(0, 40));

// a shipped .ts file would break after install (Node refuses type stripping in
// node_modules)
let leakedTypeScript = [];
try {
  leakedTypeScript = run('git', ['ls-files', '--others', '--cached', '--exclude-standard', 'dist'])
    .split('\n')
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
} catch {
  /* git unavailable: skip */
}
check('dist ships no TypeScript sources', leakedTypeScript.length === 0, leakedTypeScript.join(', '));

/* ---------------- tarball contents ---------------- */

const packOutput = run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  shell: process.platform === 'win32',
});
let pack;
try {
  // `npm pack` may print lifecycle output before the JSON document
  pack = JSON.parse(packOutput.slice(packOutput.indexOf('[')))[0];
} catch {
  pack = undefined;
}
if (!pack) {
  check('npm pack --dry-run produced a report', false, packOutput.slice(0, 200));
} else {
  const files = pack.files.map((f) => f.path);
  check('tarball is not suspiciously large', pack.size < 2 * 1024 * 1024, `${Math.round(pack.size / 1024)} KB`);
  check('tarball contains the launcher', files.includes('dist/gs.mjs'));
  check('tarball contains the GUI assets', files.some((f) => f.startsWith('dist/web/')));
  check('tarball contains the licence', files.includes('LICENSE'));
  check('tarball excludes sources', !files.some((f) => f.startsWith('src/')), 'src/ leaked');
  check('tarball excludes tests', !files.some((f) => f.startsWith('test/')), 'test/ leaked');
  check(
    'tarball carries no personal paths or emails',
    !pack.files.some((f) => /Users[\\/]|OneDrive/i.test(f.path)),
    'absolute path in a filename',
  );
  console.log(`  ${files.length} files, ${Math.round(pack.size / 1024)} KB packed`);
}

/* ---------------- optional: install the tarball ---------------- */

if (process.argv.includes('--pack')) {
  console.log('\ninstalling the tarball into a throw-away prefix…');
  const dir = await mkdtemp(path.join(tmpdir(), 'gs-publish-'));
  try {
    run('npm', ['pack', '--pack-destination', dir], { shell: process.platform === 'win32' });
    const tarball = (await import('node:fs/promises')).readdir(dir).then((names) => names.find((n) => n.endsWith('.tgz')));
    const tgz = await tarball;
    run('npm', ['install', '-g', `./${tgz}`, '--prefix', path.join(dir, 'prefix'), '--no-audit', '--no-fund'], {
      cwd: dir,
      shell: process.platform === 'win32',
    });
    const installed = path.join(dir, 'prefix', process.platform === 'win32' ? 'gs.cmd' : 'bin/gs');
    // Node cannot exec a .cmd shim directly on Windows; run it through the shell
    const version = run(installed, ['version', '--short'], {
      cwd: dir,
      shell: process.platform === 'win32',
    }).trim();
    check('the tarball installs and runs', version.includes(pkg.version), version);
  } catch (err) {
    check('the tarball installs and runs', false, err instanceof Error ? err.message : String(err));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ---------------- summary ---------------- */

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed — do NOT publish`);
  process.exitCode = 1;
} else {
  console.log(`ready to publish ${pkg.name}@${pkg.version}`);
  console.log(`  npm publish --access public --registry https://registry.npmjs.org/`);
}
