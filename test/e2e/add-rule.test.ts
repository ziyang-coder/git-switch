import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTmpHome } from '../helpers/tmp-home.ts';
import { addCommand } from '../../src/commands/add.ts';
import { loadProfiles } from '../../src/core/profiles.ts';
import { resolveIdentity } from '../../src/core/model.ts';
import { upsertRule, RuleError } from '../../src/core/rules.ts';
import { normaliseRulePath } from '../../src/core/paths.ts';
import { createLogger } from '../../src/util/log.ts';
import { Writable } from 'node:stream';

/**
 * `gs add <dir> --identity <name>` binds a directory to an identity.
 *
 * The command must be safe on a live profile: it refuses to silently reassign a
 * directory that already belongs to someone else, and it never writes a rule the
 * loader would later reject.
 */

function capture() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  (stream as unknown as { isTTY: boolean }).isTTY = false;
  return { stream, text: () => chunks.join('') };
}

const PROFILE = `schemaVersion: 1
identities:
  github:
    user:
      name: Alex Chen
      email: alex@personal.example
  company:
    user:
      name: Alex Chen
      email: alex@company.example
rules: []
`;

interface Fixture {
  home: string;
  cli: (args: { target?: string; identity?: string; force?: boolean; dryRun?: boolean }) => Promise<{ code: number; text: string }>;
  read: () => Promise<string>;
}

async function fixture(profile = PROFILE): Promise<Fixture & { cleanup: () => Promise<void> }> {
  const h = await createTmpHome();
  await mkdir(path.join(h.home, '.config', 'gs'), { recursive: true });
  await mkdir(path.join(h.home, 'code', 'github', 'repo'), { recursive: true });
  await mkdir(path.join(h.home, 'code', 'company', 'repo'), { recursive: true });
  await writeFile(path.join(h.home, '.config', 'gs', 'profiles.yaml'), profile, 'utf8');
  await writeFile(path.join(h.home, '.gitconfig'), '', 'utf8');

  const read = () => readFile(path.join(h.home, '.config', 'gs', 'profiles.yaml'), 'utf8');

  const cli: Fixture['cli'] = async (args) => {
    const out = capture();
    const code = await addCommand({
      home: h.home,
      cwd: h.home,
      ...(args.target !== undefined ? { target: args.target } : {}),
      ...(args.identity !== undefined ? { identity: args.identity } : {}),
      ...(args.force !== undefined ? { force: args.force } : {}),
      ...(args.dryRun !== undefined ? { dryRun: args.dryRun } : {}),
      logger: createLogger({ color: false, json: false, unifiedErrors: true, stream: out.stream }),
    });
    return { code, text: out.text() };
  };

  return { home: h.home, cli, read, cleanup: () => h.cleanup() };
}

test('a directory can be added to an identity', async () => {
  const f = await fixture();
  try {
    const dir = path.join(f.home, 'code', 'github', 'repo');
    const result = await f.cli({ target: dir, identity: 'github' });
    assert.equal(result.code, 0, result.text);

    const profiles = await loadProfiles(f.home);
    assert.equal(profiles.rules.length, 1);
    assert.equal(profiles.rules[0]?.identity, 'github');
  } finally {
    await f.cleanup();
  }
});

test('adding the same directory twice is a no-op', async () => {
  const f = await fixture();
  try {
    const dir = path.join(f.home, 'code', 'github', 'repo');
    await f.cli({ target: dir, identity: 'github' });
    const before = await f.read();

    const second = await f.cli({ target: dir, identity: 'github' });
    assert.equal(second.code, 0);
    assert.match(second.text, /already belongs|已属于/);
    assert.equal(await f.read(), before, 'the file is not rewritten');
  } finally {
    await f.cleanup();
  }
});

test('reassigning a directory needs --force', async () => {
  const f = await fixture();
  try {
    const dir = path.join(f.home, 'code', 'github', 'repo');
    await f.cli({ target: dir, identity: 'github' });
    const before = await f.read();

    const refused = await f.cli({ target: dir, identity: 'company' });
    assert.equal(refused.code, 2, 'without --force the command fails');
    assert.match(refused.text, /--force/);
    assert.equal(await f.read(), before, 'nothing was written');

    const forced = await f.cli({ target: dir, identity: 'company', force: true });
    assert.equal(forced.code, 0, forced.text);

    const profiles = await loadProfiles(f.home);
    assert.equal(profiles.rules.length, 1, 'the rule is replaced, not duplicated');
    assert.equal(profiles.rules[0]?.identity, 'company');
  } finally {
    await f.cleanup();
  }
});

test('an unknown identity is rejected with the available names', async () => {
  const f = await fixture();
  try {
    const before = await f.read();
    const result = await f.cli({ target: path.join(f.home, 'code', 'github'), identity: 'ghost' });
    assert.equal(result.code, 2);
    assert.match(result.text, /github/);
    assert.match(result.text, /company/);
    assert.equal(await f.read(), before);
  } finally {
    await f.cleanup();
  }
});

test('a missing --identity is an error, not a silent default', async () => {
  const f = await fixture();
  try {
    const result = await f.cli({ target: path.join(f.home, 'code', 'github') });
    assert.equal(result.code, 2);
    assert.match(result.text, /--identity/);
  } finally {
    await f.cleanup();
  }
});

test('`--dry-run` reports without writing', async () => {
  const f = await fixture();
  try {
    const before = await f.read();
    const result = await f.cli({
      target: path.join(f.home, 'code', 'company'),
      identity: 'company',
      dryRun: true,
    });
    assert.equal(result.code, 0);
    assert.equal(await f.read(), before);
  } finally {
    await f.cleanup();
  }
});

test('a file is rejected as a target', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.home, 'README.md');
    await writeFile(file, 'x', 'utf8');
    const result = await f.cli({ target: file, identity: 'github' });
    assert.equal(result.code, 2);
    assert.match(result.text, /not a directory|不是目录/);
  } finally {
    await f.cleanup();
  }
});

test('a not-yet-existing directory is accepted with a warning', async () => {
  const f = await fixture();
  try {
    const dir = path.join(f.home, 'code', 'future');
    const result = await f.cli({ target: dir, identity: 'github' });
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /does not exist yet|尚不存在/);

    const profiles = await loadProfiles(f.home);
    assert.ok(profiles.rules.some((r) => r.dir.endsWith('/future')));
  } finally {
    await f.cleanup();
  }
});

test('the written profile still loads', async () => {
  const f = await fixture();
  try {
    await f.cli({ target: path.join(f.home, 'code', 'github', 'repo'), identity: 'github' });
    await f.cli({ target: path.join(f.home, 'code', 'company', 'repo'), identity: 'company' });
    const profiles = await loadProfiles(f.home);
    assert.equal(profiles.rules.length, 2);
  } finally {
    await f.cleanup();
  }
});

test('a rule added for a subdirectory takes priority over a parent rule', async () => {
  const f = await fixture();
  try {
    // parent first, then the narrower one — the narrower must win even though
    // resolveIdentity used to depend on array order
    await f.cli({ target: path.join(f.home, 'code'), identity: 'github' });
    await f.cli({ target: path.join(f.home, 'code', 'company'), identity: 'company' });

    const profiles = await loadProfiles(f.home);
    const nested = resolveIdentity(profiles, normaliseRulePath(path.join(f.home, 'code', 'company', 'repo'), f.home));
    assert.equal(nested?.identity.name, 'company', 'the longest matching rule wins');

    const sibling = resolveIdentity(profiles, normaliseRulePath(path.join(f.home, 'code', 'github', 'repo'), f.home));
    assert.equal(sibling?.identity.name, 'github', 'the parent rule still applies elsewhere');
  } finally {
    await f.cleanup();
  }
});

// ------------------------------- core unit -------------------------------

test('resolveIdentity prefers the longest matching rule regardless of order', () => {
  const profiles = {
    schemaVersion: 1 as const,
    identities: [
      { name: 'wide', user: { name: 'w', email: 'w@example.com' } },
      { name: 'narrow', user: { name: 'n', email: 'n@example.com' } },
    ],
    sites: [],
    rules: [
      { dir: '/code', identity: 'wide' },
      { dir: '/code/team', identity: 'narrow' },
    ],
    repositories: [],
    settings: { backupKeep: 5, allowRoots: [] },
  };

  assert.equal(resolveIdentity(profiles as never, '/code/team/app')?.identity.name, 'narrow');
  assert.equal(resolveIdentity(profiles as never, '/code/other')?.identity.name, 'wide');
  // not a prefix match across segment boundaries
  assert.equal(resolveIdentity(profiles as never, '/codx/x'), undefined);
});

test('upsertRule rejects an unknown identity with a typed error', () => {
  const profiles = {
    schemaVersion: 1 as const,
    identities: [{ name: 'a', user: { name: 'a', email: 'a@example.com' } }],
    sites: [],
    rules: [],
    repositories: [],
    settings: { backupKeep: 5, allowRoots: [] },
  };

  assert.throws(
    () => upsertRule({ profiles: profiles as never, dir: '/x', identity: 'nope' }),
    (err: unknown) => err instanceof RuleError && err.kind === 'unknown-identity',
  );
});
