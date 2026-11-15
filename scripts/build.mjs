#!/usr/bin/env node
/**
 * Build the published artefact.
 *
 * Node refuses to strip types for files inside node_modules
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so shipping `.ts` sources and
 * relying on runtime stripping works from a checkout but crashes for anyone who
 * installs the package. The build therefore emits real JavaScript:
 *
 *   tsc -p tsconfig.build.json   src/**\/*.ts -> dist/**\/*.js
 *   copy web/                    -> dist/web    (assets for `gs gui`)
 *   write dist/gs.mjs            (launcher; package `bin` points here)
 *
 * TypeScript is a devDependency only: the published package still has zero
 * runtime dependencies.
 */

import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

/**
 * Build metadata recorded next to the compiled output.
 *
 * `0.1.0` alone cannot distinguish two builds of different commits, so the commit
 * count, the short hash and a `dirty` flag go into the SemVer build-metadata
 * field: `0.1.0+362.g8b4f2c1`. The same commit always yields the same string,
 * which keeps builds reproducible; only an uncommitted tree adds `.dirty`.
 */
function composeBuildInfo(baseVersion) {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
        .toString()
        .trim();
    } catch {
      return undefined;
    }
  };

  const commit = run(['rev-parse', '--short=7', 'HEAD']);
  const countRaw = run(['rev-list', '--count', 'HEAD']);
  const count = countRaw === undefined ? undefined : Number.parseInt(countRaw, 10);
  const status = run(['status', '--porcelain']);

  const info = {
    version: '',
    ...(count !== undefined && Number.isInteger(count) ? { commitCount: count } : {}),
    ...(commit !== undefined ? { commit } : {}),
    dirty: status !== undefined && status !== '',
    builtAt: new Date().toISOString(),
    channel: 'release',
  };

  const parts = [];
  if (info.commitCount !== undefined) parts.push(String(info.commitCount));
  if (info.commit !== undefined) parts.push(`g${info.commit}`);
  info.version = (parts.length > 0 ? `${baseVersion}+${parts.join('.')}` : baseVersion) + (info.dirty ? '.dirty' : '');
  return info;
}

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  // 1. compile the engine to plain JavaScript
  try {
    execFileSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], {
      cwd: root,
      stdio: 'inherit',
    });
  } catch {
    // tsc missing (fresh clone without devDependencies): fall back to Node's
    // stripper, which is enough for running from a checkout but NOT for publish.
    console.warn('tsc unavailable — falling back to source copy (not publishable)');
    await cp(path.join(root, 'src'), path.join(dist, 'src'), { recursive: true });
    const fallback = `#!/usr/bin/env node
import { main } from './src/cli.ts';
main(process.argv.slice(2)).then((code) => { process.exitCode = code; })
  .catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 2; });
`;
    await writeFile(path.join(dist, 'gs.mjs'), fallback, 'utf8');
    await cp(path.join(root, 'web'), path.join(dist, 'web'), { recursive: true });
    return;
  }

  // 2. verify the compiler actually produced the entry point
  const cli = await stat(path.join(dist, 'cli.js')).catch(() => undefined);
  if (!cli) throw new Error('tsc produced no dist/cli.js');

  // 3. static assets for the GUI
  await cp(path.join(root, 'web'), path.join(dist, 'web'), { recursive: true });

  // 4. launcher
  const launcher = `#!/usr/bin/env node
import { main } from './cli.js';

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    if (err instanceof Error && err.name === 'ProfilesMissingError') {
      console.error('✗ ' + err.message);
    } else {
      console.error('✗ ' + (err instanceof Error ? err.message : String(err)));
    }
    process.exitCode = 2;
  });
`;
  await writeFile(path.join(dist, 'gs.mjs'), launcher, 'utf8');

  const emitted = await stat(path.join(dist, 'web', 'index.html')).catch(() => undefined);
  if (!emitted) throw new Error('dist/web/index.html is missing');

  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

  // 5. record which commit produced this build, so `gs version` can name it.
  //    A checkout cannot know its own build identity, so it is stamped here.
  const buildInfo = composeBuildInfo(pkg.version);
  await writeFile(path.join(dist, 'build-info.json'), JSON.stringify(buildInfo, null, 2) + '\n', 'utf8');

  console.log(`built ${pkg.name}@${buildInfo.version} -> dist/`);
  console.log('  dist/gs.mjs        entry point (ESM)');
  console.log('  dist/*.js          engine as plain JavaScript');
  console.log('  dist/web/**        GUI assets');
  console.log('  dist/build-info.json  commit and build time');
}

main().catch((err) => {
  console.error(`build failed: ${err.message}`);
  process.exitCode = 1;
});
