import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { parseProfilesText } from '../../src/core/profiles.ts';
import { plan } from '../../src/core/plan.ts';
import { apply } from '../../src/core/apply.ts';
import { resolveIdentity } from '../../src/core/model.ts';
import { realCasePath } from '../../src/core/paths.ts';

const run = promisify(execFile);
const posix = (p: string) => p.replace(/\\/g, '/');

function profile(ruleDir: string, home: string) {
  return parseProfilesText(
    `schemaVersion: 1
identities:
  personal:
    user:
      name: p
      email: personal@x.com
    sshKey: k
    sites:
      - host: github.com
rules:
  - dir: ${ruleDir}
    identity: personal
`,
    home,
  );
}

async function gitConfigEmail(home: string, cwd: string): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, 'config', 'user.email'], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '*',
    },
  });
  return stdout.trim();
}

test('rule matching is case sensitive, mirroring git gitdir:', () => {
  const profiles = profile('/code/github', '/home/u');
  assert.ok(resolveIdentity(profiles, '/code/github/repo'));
  assert.equal(
    resolveIdentity(profiles, '/code/GitHub/repo'),
    undefined,
    'gs must not claim a match git would not honour',
  );
});

/**
 * Whether the filesystem under `dir` folds case.
 *
 * Windows and macOS normally do, but not always: a Windows machine can have
 * case-sensitive directories enabled, and a macOS runner may use a
 * case-sensitive volume. Probing is exact, a platform check is a guess.
 */
async function fsFoldsCase(dir: string): Promise<boolean> {
  const { mkdir, rename, stat, rm } = await import('node:fs/promises');
  const probe = path.join(dir, 'CaseProbe');
  const renamed = path.join(dir, 'caseprobe');
  try {
    await mkdir(probe, { recursive: true });
    // on a folding filesystem these are the same entry, so the rename succeeds
    await rename(probe, renamed);
    await stat(probe);
    await rm(probe, { recursive: true, force: true }).catch(() => {});
    return true;
  } catch {
    await rm(probe, { recursive: true, force: true }).catch(() => {});
    await rm(renamed, { recursive: true, force: true }).catch(() => {});
    return false;
  }
}

test('realCasePath aligns a rule with on-disk casing', async (t) => {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    t.skip('case-insensitive filesystems only');
    return;
  }
  const h = await createTmpHome();
  try {
    if (!(await fsFoldsCase(h.home))) {
      t.skip('this volume is case-sensitive, so there is no casing to align');
      return;
    }
    await mkdir(path.join(h.home, 'CODE', 'GitHub'), { recursive: true });
    const actual = await realCasePath(`${posix(h.home)}/code/github`, h.home);
    assert.equal(actual, `${posix(h.home)}/CODE/GitHub`);
  } finally {
    await h.cleanup();
  }
});

test('a rule reached through a symlink resolves to the real path', async () => {
  // git compares `gitdir:` against the repository's REAL path. A rule written
  // through a link therefore never matched: on macOS every temp directory is
  // /var/folders/… which is a symlink to /private/var/folders/…, so includeIf
  // silently did nothing and the global identity won. Linux CI showed the same
  // failures once the rule paths were checked.
  if (process.platform === 'win32') {
    // creating a symlink needs elevation on Windows; the logic is covered on posix
    return;
  }
  const h = await createTmpHome();
  try {
    const { mkdir, symlink } = await import('node:fs/promises');
    const real = path.join(h.home, 'real');
    await mkdir(path.join(real, 'code'), { recursive: true });
    const link = path.join(h.home, 'link');
    await symlink(real, link, 'dir');

    const throughLink = await realCasePath(`${posix(link)}/code`, h.home);
    assert.equal(throughLink, `${posix(real)}/code`, 'a symlinked rule must resolve to the target');
  } finally {
    await h.cleanup();
  }
});

test('a rule written in the wrong case still works after apply', async (t) => {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    t.skip('case-insensitive filesystems only');
    return;
  }
  const h = await createTmpHome();
  try {
    if (!(await fsFoldsCase(h.home))) {
      t.skip('this volume is case-sensitive, so there is no casing to align');
      return;
    }
    await h.write('.gitconfig', '[user]\n\tname = g\n\temail = global@x.com\n');
    const repo = path.join(h.home, 'CODE', 'GitHub', 'Repo');
    await mkdir(repo, { recursive: true });
    await h.write('.ssh/k', '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n');
    await run('git', ['init', '-q'], { cwd: repo });

    // the rule is written in lower case while the directory is CODE/GitHub
    const profiles = profile(`${posix(h.home)}/code/github`, h.home);
    await apply(await plan({ home: h.home, profiles }), { home: h.home });

    const written = await h.read('.gitconfig');
    assert.match(written, /CODE\/GitHub\//, 'the generated gitdir must use the real casing');

    assert.equal(
      await gitConfigEmail(h.home, repo),
      'personal@x.com',
      'git must actually resolve the identity',
    );
  } finally {
    await h.cleanup();
  }
});

test('non-ASCII rule paths work end to end', async () => {
  const h = await createTmpHome();
  try {
    await h.write('.gitconfig', '[user]\n\tname = g\n\temail = global@x.com\n');
    const repo = path.join(h.home, '配置', '工作', '项目');
    await mkdir(repo, { recursive: true });
    await h.write('.ssh/k', '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n');
    await run('git', ['init', '-q'], { cwd: repo });

    const profiles = profile(`${posix(h.home)}/配置/工作`, h.home);
    await apply(await plan({ home: h.home, profiles }), { home: h.home });

    const written = await h.read('.gitconfig');
    assert.match(written, /配置\/工作\//);
    assert.equal(await gitConfigEmail(h.home, repo), 'personal@x.com');
  } finally {
    await h.cleanup();
  }
});
