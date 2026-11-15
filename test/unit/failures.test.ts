import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { parseProfilesText, loadProfiles } from '../../src/core/profiles.ts';
import { plan } from '../../src/core/plan.ts';
import { apply } from '../../src/core/apply.ts';
import { writeFileAtomic } from '../../src/util/fs-atomic.ts';

const posix = (p: string) => p.replace(/\\/g, '/');
/**
 * Root ignores mode bits, so a `chmod 400` target stays writable and the failure
 * these tests are about never occurs. CI containers run as root by default.
 */
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/* ------------------------------------------------------------------ */
/* malformed profiles must be rejected with actionable errors          */
/* ------------------------------------------------------------------ */

const MALFORMED: { name: string; yaml: string; expect: RegExp }[] = [
  { name: 'tab indentation', yaml: 'schemaVersion: 1\nidentities:\n\tbad: x\n', expect: /tabs are not allowed/ },
  { name: 'missing schemaVersion', yaml: 'identities: {}\n', expect: /missing schemaVersion/ },
  { name: 'unknown schemaVersion', yaml: 'schemaVersion: 99\nidentities: {}\n', expect: /unsupported schemaVersion 99/ },
  { name: 'no identities', yaml: 'schemaVersion: 1\nidentities: {}\n', expect: /at least one identity/ },
  {
    name: 'password field',
    yaml: 'schemaVersion: 1\nidentities:\n  a:\n    user: { name: a, email: a@example.com }\n    password: secret\n',
    expect: /must not contain secrets/,
  },
  {
    name: 'rule with unknown identity',
    yaml: 'schemaVersion: 1\nidentities:\n  a:\n    user: { name: a, email: a@example.com }\nrules:\n  - dir: /x\n    identity: ghost\n',
    expect: /unknown identity "ghost"/,
  },
  { name: 'top level is a list', yaml: '- a\n- b\n', expect: /top level must be a mapping/ },
  {
    name: 'invalid email',
    yaml: 'schemaVersion: 1\nidentities:\n  a:\n    user: { name: a, email: not-an-email }\n',
    expect: /not a valid email/,
  },
  {
    name: 'sshKey with a path',
    yaml: 'schemaVersion: 1\nidentities:\n  a:\n    user: { name: a, email: a@example.com }\n    sshKey: ../../etc/passwd\n',
    expect: /file name under ~\/\.ssh/,
  },
  {
    name: 'port out of range',
    yaml: 'schemaVersion: 1\nidentities:\n  a:\n    user: { name: a, email: a@example.com }\n    sites:\n      - host: h.com\n        port: 99999\n',
    expect: /port out of range/,
  },
  {
    name: 'duplicate keys',
    yaml: 'schemaVersion: 1\nschemaVersion: 1\nidentities: {}\n',
    expect: /duplicate key/,
  },
];

for (const item of MALFORMED) {
  test(`a malformed profile is rejected: ${item.name}`, () => {
    assert.throws(() => parseProfilesText(item.yaml, '/home/u'), item.expect);
  });
}

/* ------------------------------------------------------------------ */
/* filesystem failures                                                 */
/* ------------------------------------------------------------------ */

async function profileWithRules(home: string) {
  return parseProfilesText(
    `schemaVersion: 1
identities:
  p:
    user:
      name: p
      email: p@example.com
rules:
  - dir: ${posix(home)}/code
    identity: p
`,
    home,
  );
}

test('a read-only target reports a permission error, not a silent success', async (t) => {
  if (process.platform === 'win32') {
    // Windows read-only is an attribute; simulate the same failure by making the
    // directory unwritable instead. Skip when not elevated enough to observe it.
    t.skip('read-only attribute semantics differ on Windows');
  }
  if (isRoot) {
    t.skip('root ignores mode bits, so a read-only target is still writable');
    return;
  }
  const h = await createTmpHome();
  const identities = path.join(h.home, '.config', 'gs', 'identities');
  try {
    await h.write('.gitconfig', '[user]\n\tname = g\n');

    // Writes are atomic: a temp file in the same directory is renamed over the
    // target, and rename ignores the target's own mode, so a read-only *file*
    // stays replaceable by design. A read-only *directory* is what blocks a write.
    // `profileWithRules` has no site, so the only file this apply creates is the
    // identity config — locking its directory makes that one write fail.
    await mkdir(identities, { recursive: true });
    await chmod(identities, 0o555);

    const p = await plan({ home: h.home, profiles: await profileWithRules(h.home) });
    const result = await apply(p, { home: h.home });

    assert.ok(result.errors.length > 0, 'the failure must be reported');
    const message = result.errors[0]?.message ?? '';
    assert.match(message, /permission denied|cannot write/);
    assert.match(message, /identities/, 'the error names the real target file');
  } finally {
    await chmod(identities, 0o755).catch(() => {});
    await h.cleanup();
  }
});

test('writeFileAtomic names the target file and leaves no temp file behind', async () => {
  const h = await createTmpHome();
  try {
    await mkdir(path.join(h.home, 'sub'), { recursive: true });
    const target = path.join(h.home, 'sub', 'file.txt');
    await writeFileAtomic(target, 'hello');
    assert.equal(await h.read('sub/file.txt'), 'hello');

    const leftovers = (await import('node:fs/promises')).readdir(path.join(h.home, 'sub'));
    const names = await leftovers;
    assert.deepEqual(names, ['file.txt'], 'no .gs-tmp files remain');
  } finally {
    await h.cleanup();
  }
});

test('a failed write does not leave the target half written', async (t) => {
  if (process.platform === 'win32') {
    t.skip('simulated with a directory in place of the file');
    return;
  }
  const h = await createTmpHome();
  try {
    // a directory where a file is expected makes rename fail
    await mkdir(path.join(h.home, 'target'), { recursive: true });
    await assert.rejects(() => writeFileAtomic(path.join(h.home, 'target'), 'x'));

    const { readdir } = await import('node:fs/promises');
    const names = await readdir(h.home);
    assert.ok(
      names.every((n) => !n.includes('gs-tmp')),
      `temp files leaked: ${names.join(', ')}`,
    );
  } finally {
    await h.cleanup();
  }
});

test('apply reports one error per failed file and still writes the rest', async (t) => {
  if (process.platform === 'win32') {
    t.skip('relies on posix permissions');
    return;
  }
  if (isRoot) {
    t.skip('root ignores mode bits, so a read-only target is still writable');
    return;
  }
  const h = await createTmpHome();
  const identities = path.join(h.home, '.config', 'gs', 'identities');
  try {
    // a profile with a site, so apply writes ~/.gitconfig, the identity config
    // and ~/.ssh/config — three targets in three directories
    await h.write(
      '.config/gs/profiles.yaml',
      `schemaVersion: 1
identities:
  p:
    user:
      name: p
      email: p@example.com
    sshKey: id_p
    sites:
      - host: github.com
        alias: gh
rules: []
`,
    );
    await h.write('.gitconfig', '[user]\n\tname = g\n');

    // Writes are atomic: a temp file in the same directory is renamed over the
    // target, and rename ignores the target's own mode, so a read-only *file* is
    // replaceable by design. A read-only *directory* is what blocks a write.
    // Locking just the identities directory makes exactly one target fail.
    await mkdir(identities, { recursive: true });
    await chmod(identities, 0o555);

    const profiles = await loadProfiles(h.home);
    const p = await plan({ home: h.home, profiles });
    const result = await apply(p, { home: h.home });

    assert.equal(result.errors.length, 1, JSON.stringify(result.errors));
    assert.match(result.errors[0]?.message ?? '', /permission denied|cannot write/);
    assert.match(result.errors[0]?.file ?? '', /identities/, 'the error names the real target');
    // the other generated files are unaffected by the identity-config failure
    assert.ok(
      result.written.some((w) => w.includes('.ssh/config')),
      `the ssh config must still be written: ${JSON.stringify(result.written)}`,
    );
  } finally {
    await chmod(identities, 0o755).catch(() => {});
    await h.cleanup();
  }
});
