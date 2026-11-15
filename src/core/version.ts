/**
 * Version and build metadata.
 *
 * `gs version` must answer three questions: which release is this, who wrote it,
 * and which commit produced this particular binary. The first two come from
 * `package.json`; the third cannot — a checkout does not know its own build — so
 * `scripts/build.mjs` writes `build-info.json` next to the compiled output and
 * this module reads it.
 *
 * Running straight from the TypeScript sources (the development path) has no
 * build step, so the build fields fall back to live `git` query and the version
 * reports `+dev`, which is honest about not being a release build.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PackageMeta {
  name: string;
  version: string;
  description?: string;
  license?: string;
  author?: string;
  homepage?: string;
  repository?: string;
}

export interface BuildInfo {
  /** Full version including build metadata, e.g. `0.1.0+362.g8b4f2c1`. */
  version: string;
  /** Commits reachable from HEAD; absent outside a git checkout. */
  commitCount?: number;
  /** Abbreviated commit hash. */
  commit?: string;
  /** True when the working tree had uncommitted changes at build time. */
  dirty?: boolean;
  /** ISO timestamp of the build (or of the query, in dev mode). */
  builtAt: string;
  /** `release` for a built dist/, `dev` when running from sources. */
  channel: 'release' | 'dev';
}

export interface VersionReport {
  version: string;
  package: PackageMeta;
  build: BuildInfo;
}

/** Read `package.json`, tolerating both `dist/` and `src/` layouts. */
export function readPackageMeta(from?: string): PackageMeta {
  const start = from ?? path.dirname(fileURLToPath(import.meta.url));

  // walk up until a package.json appears; the module lives in src/core or dist/core
  let dir = start;
  for (let i = 0; i < 6; i++) {
    try {
      const raw = readFileSync(path.join(dir, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      return normalisePackage(pkg);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return { name: 'git-switch', version: '0.0.0', license: 'MIT' };
}

function normalisePackage(pkg: Record<string, unknown>): PackageMeta {
  const author = pkg.author;
  let authorName: string | undefined;
  let authorUrl: string | undefined;
  if (typeof author === 'string') {
    // "Name <email> (url)" — keep the name and the url
    authorName = author.replace(/\s*<[^>]*>/, '').replace(/\s*\(([^)]*)\)\s*/, '').trim() || undefined;
    const url = /\(([^)]+)\)/.exec(author);
    authorUrl = url?.[1];
  } else if (author && typeof author === 'object') {
    const obj = author as { name?: unknown; url?: unknown };
    authorName = typeof obj.name === 'string' ? obj.name : undefined;
    authorUrl = typeof obj.url === 'string' ? obj.url : undefined;
  }

  const repository = pkg.repository;
  let repoUrl: string | undefined;
  if (typeof repository === 'string') repoUrl = repository;
  else if (repository && typeof repository === 'object') {
    const url = (repository as { url?: unknown }).url;
    repoUrl = typeof url === 'string' ? url : undefined;
  }
  // git+https://github.com/x/y.git -> https://github.com/x/y
  if (repoUrl) repoUrl = repoUrl.replace(/^git\+/, '').replace(/\.git$/, '');

  return {
    name: typeof pkg.name === 'string' ? pkg.name : 'git-switch',
    version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
    ...(typeof pkg.description === 'string' ? { description: pkg.description } : {}),
    ...(typeof pkg.license === 'string' ? { license: pkg.license } : {}),
    ...(authorName ? { author: authorName } : {}),
    ...(repoUrl ? { repository: repoUrl } : {}),
    ...(typeof pkg.homepage === 'string' ? { homepage: pkg.homepage } : {}),
    ...(authorUrl ? { authorUrl } : {}),
  } as PackageMeta;
}

/** Query git for the commit that produced the working tree. */
function gitInfo(cwd: string): { commitCount?: number; commit?: string; dirty?: boolean } {
  const run = (args: string[]): string | undefined => {
    try {
      return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 })
        .toString()
        .trim();
    } catch {
      return undefined;
    }
  };

  const commit = run(['rev-parse', '--short=7', 'HEAD']);
  if (commit === undefined) return {};

  const countRaw = run(['rev-list', '--count', 'HEAD']);
  const count = countRaw === undefined ? undefined : Number.parseInt(countRaw, 10);
  const status = run(['status', '--porcelain']);

  return {
    ...(count !== undefined && Number.isInteger(count) ? { commitCount: count } : {}),
    commit,
    dirty: status !== undefined && status !== '',
  };
}

/**
 * Compose the SemVer string.
 *
 * `0.1.0` + commit count + hash → `0.1.0+362.g8b4f2c1`; append `.dirty` when the
 * tree had changes. The `+` build-metadata field is SemVer-legal and ignored by
 * version comparison, so a released `0.1.0` and a local `0.1.0+5.g…` sort equal.
 */
export function composeVersion(base: string, info: BuildInfo): string {
  if (info.channel === 'dev') return `${base}+dev`;
  const parts: string[] = [];
  if (info.commitCount !== undefined) parts.push(String(info.commitCount));
  if (info.commit !== undefined) parts.push(`g${info.commit}`);
  let version = parts.length > 0 ? `${base}+${parts.join('.')}` : base;
  if (info.dirty) version += '.dirty';
  return version;
}

/** Locate `build-info.json` written by the build next to the compiled modules. */
function findBuildInfo(start: string): BuildInfo | undefined {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    try {
      const raw = readFileSync(path.join(dir, 'build-info.json'), 'utf8');
      return JSON.parse(raw) as BuildInfo;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

let cached: VersionReport | undefined;

/** The full version report, computed once per process. */
export function versionReport(): VersionReport {
  if (cached) return cached;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkg = readPackageMeta(here);
  const recorded = findBuildInfo(here);

  if (recorded && recorded.channel === 'release') {
    cached = { version: recorded.version, package: pkg, build: recorded };
    return cached;
  }

  // development path: no build step ran, so ask git directly
  const root = findRepoRoot(here) ?? here;
  const info = gitInfo(root);
  const build: BuildInfo = {
    version: '',
    ...info,
    builtAt: new Date().toISOString(),
    channel: 'dev',
  };
  build.version = composeVersion(pkg.version, build);
  cached = { version: build.version, package: pkg, build };
  return cached;
}

function findRepoRoot(start: string): string | undefined {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    // `.git` is a directory in a normal clone and a file in a worktree; existsSync
    // covers both without caring which.
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
