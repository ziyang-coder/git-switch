import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmpHome, type TmpHome } from '../helpers/tmp-home.ts';

/**
 * CLI contract: argument parsing, exit codes and `--json` stability.
 *
 * Everything here spawns the real entry point (`node src/cli.ts …`). The point
 * of these tests is what a user (or a script) actually observes — the process
 * exit status and the two streams — so nothing is imported from `src/`.
 *
 * Exit-code contract, as documented in README.md and in `gs help`:
 *   0 = ok · 1 = warning · 2 = error
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const cliPath = path.join(repoRoot, 'src', 'cli.ts');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const execFileAsync = promisify(execFile);

/**
 * Run the CLI and never throw: a non-zero exit is a result, not an exception.
 *
 * `GS_LANG` and the OS locale are pinned to English so the assertions below do
 * not depend on the machine running the suite; user messages are translated.
 */
function runCli(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      {
        cwd: opts.cwd ?? repoRoot,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'safe.directory',
          GIT_CONFIG_VALUE_0: '*',
          GS_LANG: 'en',
          // keep the developer's identity out of any `git config` read
          GIT_AUTHOR_NAME: '',
          GIT_AUTHOR_EMAIL: '',
          ...opts.env,
        },
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err && typeof (err as { code?: unknown }).code !== 'number') {
          reject(err);
          return;
        }
        const code = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

const ANSI = '\u001b[';

const PROFILE = `schemaVersion: 1
identities:
  work:
    user:
      name: Alex Chen
      email: alex@company.example
    sshKey: id_work
  personal:
    user:
      name: alexchen
      email: alex@personal.example
    sshKey: id_gh
rules:
  - dir: __HOME__/code/work
    identity: work
  - dir: __HOME__/code/personal
    identity: personal
`;

/** A home with a profile, the two directories the rules point at, and a global identity. */
async function seed(h: TmpHome): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(h.home, 'code', 'work'), { recursive: true });
  await mkdir(path.join(h.home, 'code', 'personal'), { recursive: true });
  await h.write('.config/gs/profiles.yaml', PROFILE.replace(/__HOME__/g, h.home.replace(/\\/g, '/')));
  await h.write('.gitconfig', '[user]\n\tname = gs test\n\temail = gs@test.example\n');
}

/** Home with a profile but no rules, so `apply` has something to write and little else. */
async function seedBare(h: TmpHome): Promise<void> {
  await h.write(
    '.config/gs/profiles.yaml',
    'schemaVersion: 1\nidentities:\n  work:\n    user:\n      name: Alex\n      email: alex@company.example\n',
  );
}

function parseJson(result: RunResult, what: string): Record<string, unknown> {
  assert.equal(result.code, 0, `${what} must succeed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    assert.fail(`${what} --json printed something that is not JSON:\n${result.stdout}`);
  }
}

/* ================================================================== */
/* argument parsing                                                    */
/* ================================================================== */

test('global flags accept both `--flag value` and `--flag=value`', async () => {
  const h = await createTmpHome();
  try {
    await seed(h);
    const spaced = await runCli(['list', '--home', h.home, '--json', '--no-color']);
    const equalled = await runCli(['list', `--home=${h.home}`, '--json', '--no-color']);

    assert.equal(spaced.code, 0, spaced.stderr);
    assert.equal(equalled.code, 0, equalled.stderr);
    const a = JSON.parse(spaced.stdout) as { identities: unknown[] };
    const b = JSON.parse(equalled.stdout) as { identities: unknown[] };
    assert.equal(a.identities.length, 2);
    assert.deepEqual(a.identities, b.identities, 'both spellings must select the same home');
  } finally {
    await h.cleanup();
  }
});

test('a repeated single-valued flag keeps the last value', async () => {
  const h = await createTmpHome();
  try {
    await seed(h);
    const result = await runCli([
      'list',
      '--home', path.join(h.home, 'definitely-not-here'),
      '--home', h.home,
      '--json',
      '--no-color',
    ]);
    assert.equal(result.code, 0, result.stderr);
    const data = JSON.parse(result.stdout) as { identities: { name: string }[] };
    assert.deepEqual(
      data.identities.map((i) => i.name).sort(),
      ['personal', 'work'],
    );
  } finally {
    await h.cleanup();
  }
});

test('a multi-valued flag keeps every occurrence (--remap)', async () => {
  const source = await createTmpHome();
  const target = await createTmpHome();
  const snapshot = path.join(source.home, 'snap.gsnap');
  try {
    await source.write(
      '.config/gs/profiles.yaml',
      [
        'schemaVersion: 1',
        'identities:',
        '  w:',
        '    user:',
        '      name: w',
        '      email: w@example.com',
        'rules:',
        '  - dir: D:/CODE/company',
        '    identity: w',
        '  - dir: D:/CODE/github',
        '    identity: w',
        '',
      ].join('\n'),
    );
    const exported = await runCli(['snapshot', 'export', snapshot, '--home', source.home, '--force', '--no-color']);
    assert.equal(exported.code, 0, exported.stderr);

    const imported = await runCli([
      'snapshot', 'import', snapshot,
      '--home', target.home,
      '--remap', 'D:/CODE/company=/opt/pde',
      '--remap', 'D:/CODE/github=/opt/gh',
      '--no-color',
    ]);
    assert.equal(imported.code, 0, `${imported.stdout}\n${imported.stderr}`);

    const written = await readFile(path.join(target.home, '.config', 'gs', 'profiles.yaml'), 'utf8');
    assert.match(written, /\/opt\/pde/, 'the first --remap must survive the second one');
    assert.match(written, /\/opt\/gh/);
  } finally {
    await source.cleanup();
    await target.cleanup();
  }
});

test('a value flag with nothing after it exits 2 instead of waiting for stdin', async () => {
  for (const args of [['list', '--home'], ['add', '--identity'], ['snapshot', 'export', '--remap']]) {
    const result = await runCli(args);
    assert.equal(result.code, 2, `\`gs ${args.join(' ')}\` must exit 2, not ${result.code}`);
    assert.match(result.stderr, /missing value/i, `the reason must be on stderr: ${result.stderr}`);
  }
});

test('a value flag must not swallow the next flag as its value', async () => {
  // `gs list --home --no-color`: `--home` has no value, so this has to be
  // reported as an error. Silently treating "--no-color" as a directory name
  // turns a typo into a confusing "no profile found at --no-color/…" report.
  const result = await runCli(['list', '--home', '--no-color']);
  assert.equal(result.code, 2, 'still an error, but for the right reason');
  assert.doesNotMatch(
    result.stderr + result.stdout,
    /--no-color[\\/]+\.config/i,
    `a flag must never be used as a path value:\n${result.stderr}${result.stdout}`,
  );
});

test('an unknown subcommand exits 2 and says which command was wrong', async () => {
  const result = await runCli(['frobnicate', '--no-color']);
  assert.equal(result.code, 2, 'an unknown command is an error, not a successful help screen');
  assert.match(result.stdout + result.stderr, /frobnicate/);
});

test('an unknown flag is rejected rather than silently ignored', async () => {
  // `--dryrun` (one dash too few) is the realistic typo; silently accepting it
  // would make the next `apply` write to ~/.gitconfig for real.
  const h = await createTmpHome();
  try {
    await seedBare(h);
    const result = await runCli(['apply', '--home', h.home, '--dryrun', '--no-color']);
    const gitconfigWritten = await h.exists('.gitconfig');
    assert.ok(
      result.code === 2 || (result.code === 0 && !gitconfigWritten),
      `\`apply --dryrun\` must not apply. exit=${result.code} wrote .gitconfig=${gitconfigWritten}\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  } finally {
    await h.cleanup();
  }
});

/* ================================================================== */
/* --json                                                              */
/* ================================================================== */

test('every command emits parseable JSON when --json is passed', async () => {
  const h = await createTmpHome();
  try {
    await seed(h);
    // both keys the profile references must exist, otherwise `doctor` rightly
    // reports errors and exits 2 — this test is about the document, not the verdict
    await h.write('.ssh/id_work', '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n');
    await h.write('.ssh/id_gh', '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(h.home, 'code', 'work', 'repo'), { recursive: true });
    const snap = path.join(h.home, 'out.gsnap');
    await execFileAsync('git', ['init', '-q'], { cwd: path.join(h.home, 'code', 'work', 'repo') });

    const cases: { name: string; args: string[]; keys: string[] }[] = [
      { name: 'list', args: ['list'], keys: ['identities', 'rules'] },
      { name: 'diff', args: ['diff'], keys: ['dirty', 'files'] },
      { name: 'apply --dry-run', args: ['apply', '--dry-run'], keys: ['dryRun', 'wouldChange'] },
      { name: 'apply', args: ['apply'], keys: ['written'] },
      { name: 'doctor', args: ['doctor'], keys: ['results', 'errors', 'warnings'] },
      { name: 'key list', args: ['key', 'list'], keys: ['keys'] },
      { name: 'version', args: ['version'], keys: ['version', 'package', 'build'] },
    ];
    for (const c of cases) {
      const result = await runCli([...c.args, '--home', h.home, '--json', '--no-color']);
      const data = parseJson(result, `gs ${c.name}`);
      assert.ok(!result.stdout.includes(ANSI), `gs ${c.name} --json must never paint its JSON`);
      for (const key of c.keys) {
        assert.ok(key in data, `gs ${c.name} --json must expose "${key}", got: ${Object.keys(data).join(', ')}`);
      }
    }

    const added = await runCli(['add', path.join(h.home, 'code', 'extra'), '--identity', 'work', '--home', h.home, '--json', '--no-color']);
    const addedData = parseJson(added, 'gs add');
    assert.equal(addedData.dir, '~/code/extra');
    assert.equal(addedData.action, 'added');

    const exported = await runCli(['snapshot', 'export', snap, '--home', h.home, '--json', '--force', '--no-color']);
    const exportedData = parseJson(exported, 'gs snapshot export');
    assert.equal(exportedData.containsKeys, false);
    assert.ok(typeof exportedData.files === 'number');
  } finally {
    await h.cleanup();
  }
});

test('a failing doctor still emits JSON, and its exit code matches its own error count', async () => {
  const h = await createTmpHome();
  try {
    // both keys are missing: doctor must report errors, exit 2, and stay parseable
    await seed(h);
    const result = await runCli(['doctor', '--home', h.home, '--json', '--no-color']);
    const data = JSON.parse(result.stdout) as { errors: number; warnings: number };
    assert.equal(result.code, 2, 'errors in the report mean an error exit code');
    assert.ok(data.errors > 0, 'the missing keys must be listed as errors');
    assert.equal(data.errors, 2, 'one error per missing key');
  } finally {
    await h.cleanup();
  }
});

test('--json keeps stdout pure JSON even when the command fails', async () => {
  const h = await createTmpHome();
  try {
    await h.write(
      '.config/gs/profiles.yaml',
      'schemaVersion: 1\nidentities:\n  work:\n    user:\n      name: Alex\n      email: not-an-email\n',
    );
    const result = await runCli(['list', '--home', h.home, '--json', '--no-color']);
    assert.equal(result.code, 2, 'a broken profile is an error');

    // A caller that asked for --json gets a document even on failure: an empty
    // stdout would force it to parse a human sentence out of stderr.
    const parsed = JSON.parse(result.stdout) as { error?: string; code?: number };
    assert.equal(typeof parsed.error, 'string', 'the failure is described in the document');
    assert.match(parsed.error ?? '', /not-an-email/, 'and it names the offending value');
    assert.equal(parsed.code, 2);
    assert.equal(result.stdout.trim().split('\n').length, 1, 'stdout carries exactly one JSON document');
  } finally {
    await h.cleanup();
  }
});

/* ================================================================== */
/* exit codes                                                          */
/* ================================================================== */

test('a missing profile is an error (2) and names the file', async () => {
  const h = await createTmpHome();
  try {
    for (const args of [['list'], ['diff'], ['apply'], ['doctor'], ['add', '--identity', 'work']]) {
      const result = await runCli([...args, '--home', h.home, '--no-color']);
      assert.equal(result.code, 2, `\`gs ${args.join(' ')}\` with no profile must exit 2, got ${result.code}`);
      assert.match(result.stdout + result.stderr, /no profile found/i);
    }
  } finally {
    await h.cleanup();
  }
});

test('a malformed profile is an error (2) for every command that reads it', async () => {
  const h = await createTmpHome();
  try {
    await h.write('.config/gs/profiles.yaml', 'schemaVersion: 1\nidentities: {}\n');
    for (const args of [['list'], ['diff'], ['apply'], ['doctor']]) {
      const result = await runCli([...args, '--home', h.home, '--no-color']);
      assert.equal(result.code, 2, `\`gs ${args.join(' ')}\` on an invalid profile must exit 2, got ${result.code}\n${result.stdout}`);
    }
  } finally {
    await h.cleanup();
  }
});

test('a successful apply is 0 and a second apply is 0 with no changes', async () => {
  const h = await createTmpHome();
  try {
    await seed(h);
    const first = await runCli(['apply', '--home', h.home, '--no-color']);
    assert.equal(first.code, 0, first.stdout + first.stderr);
    assert.ok(await h.exists('.gitconfig'), 'apply must write the global config');
    assert.match(await h.read('.gitconfig'), /gs:managed/, 'apply must write the managed block');

    const second = await runCli(['apply', '--home', h.home, '--no-color']);
    assert.equal(second.code, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /no changes/i, 'the second apply must report that nothing changed');
  } finally {
    await h.cleanup();
  }
});

test('apply --dry-run leaves the home untouched and exits 0', async () => {
  const h = await createTmpHome();
  try {
    await seed(h);
    const result = await runCli(['apply', '--dry-run', '--home', h.home, '--no-color']);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const gitconfig = await h.read('.gitconfig');
    assert.ok(!gitconfig.includes('gs:managed'), '--dry-run must not touch ~/.gitconfig');
    assert.ok(!(await h.exists('.ssh/config')), '--dry-run must not create ~/.ssh/config');
    assert.ok(
      !(await h.exists('.config/gs/identities/work.gitconfig')),
      '--dry-run must not write generated identity configs',
    );
  } finally {
    await h.cleanup();
  }
});

test('an operation the user cannot be asked about is an error (2), not a hang', async () => {
  const h = await createTmpHome();
  try {
    await seedBare(h);
    await h.write('.ssh/id_work', '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n');
    const snap = path.join(h.home, 'with-keys.gsnap');
    // --with-keys needs a passphrase; stdin is not a TTY, so there is none
    const result = await runCli(['snapshot', 'export', snap, '--home', h.home, '--with-keys', '--no-color'], {
      env: { GS_PASSPHRASE: '' },
    });
    assert.equal(result.code, 2, `a missing passphrase must exit 2, got ${result.code}\n${result.stdout}`);
    assert.match(result.stdout + result.stderr, /passphrase/i);
  } finally {
    await h.cleanup();
  }
});

test('key restore reports a snapshot without keys as a warning (1)', async () => {
  const h = await createTmpHome();
  try {
    await seedBare(h);
    // a well-formed snapshot envelope with no key files in it
    const snapshot = {
      manifest: {
        format: 'gs-snapshot',
        version: 1,
        createdAt: new Date().toISOString(),
        sourceHome: '/home/someone',
        containsKeys: false,
        files: [],
      },
      files: [],
    };
    const file = path.join(h.home, 'empty.gsnap');
    await h.write('empty.gsnap', JSON.stringify(snapshot));

    const result = await runCli(['key', 'restore', file, '--home', h.home, '--no-color']);
    assert.equal(result.code, 1, `nothing to restore is a warning, got ${result.code}\n${result.stdout}${result.stderr}`);
  } finally {
    await h.cleanup();
  }
});

test('unknown key and snapshot subcommands exit 2', async () => {
  const h = await createTmpHome();
  try {
    await seedBare(h);
    for (const args of [['key', 'bogus'], ['snapshot', 'bogus']]) {
      const result = await runCli([...args, '--home', h.home, '--no-color']);
      assert.equal(result.code, 2, `\`gs ${args.join(' ')}\` must exit 2, got ${result.code}`);
    }
  } finally {
    await h.cleanup();
  }
});

test('snapshot import failure modes all exit 2', async () => {
  const h = await createTmpHome();
  try {
    await seedBare(h);
    const missing = await runCli(['snapshot', 'import', path.join(h.home, 'nope.gsnap'), '--home', h.home, '--no-color']);
    assert.equal(missing.code, 2, 'a missing file is an error');

    await h.write('bad.gsnap', 'this is not json');
    const bad = await runCli(['snapshot', 'import', path.join(h.home, 'bad.gsnap'), '--home', h.home, '--no-color']);
    assert.equal(bad.code, 2, 'unparseable input is an error');

    const noTarget = await runCli(['snapshot', 'import', '--home', h.home, '--no-color']);
    assert.equal(noTarget.code, 2, 'a missing operand is an error');
  } finally {
    await h.cleanup();
  }
});

test('help, version and --version exit 0', async () => {
  for (const args of [['help'], ['version'], ['version', '--short'], ['--version'], ['--help'], []]) {
    const result = await runCli([...args, '--no-color']);
    assert.equal(result.code, 0, `\`gs ${args.join(' ')}\` must exit 0, got ${result.code}`);
    assert.ok(result.stdout.length > 0, `\`gs ${args.join(' ')}\` must print something`);
  }
});

test('add rejects an unknown identity with exit 2 and changes nothing', async () => {
  const h = await createTmpHome();
  try {
    await seedBare(h);
    const before = await h.read('.config/gs/profiles.yaml');
    const result = await runCli(['add', path.join(h.home, 'code'), '--identity', 'ghost', '--home', h.home, '--no-color']);
    assert.equal(result.code, 2, `unknown identity must exit 2, got ${result.code}`);
    assert.equal(await h.read('.config/gs/profiles.yaml'), before, 'a failed add must not rewrite the profile');
  } finally {
    await h.cleanup();
  }
});

/* ================================================================== */
/* argument parsing edge cases                                         */
/* ================================================================== */

test('`--` is accepted as an end-of-options marker', async () => {
  const h = await createTmpHome();
  try {
    await seed(h);
    // After `--` every token is a positional, so the command must still be found.
    // Options that follow belong to the command, not to the marker.
    const result = await runCli(['--home', h.home, '--json', '--no-color', 'list']);
    assert.equal(result.code, 0, `options before the command must work:\n${result.stdout}\n${result.stderr}`);
    assert.doesNotThrow(() => JSON.parse(result.stdout));

    // A literal `--` makes the rest positional: `gs -- list` still dispatches list
    const quoted = await runCli(['--home', h.home, '--json', '--no-color', '--', 'list']);
    assert.equal(quoted.code, 0, `GNU-style \`--\` must not break dispatch:\n${quoted.stdout}\n${quoted.stderr}`);
    assert.doesNotThrow(() => JSON.parse(quoted.stdout));
  } finally {
    await h.cleanup();
  }
});

test('`--lang` works in both spellings and overrides GS_LANG', async () => {
  const spaced = await runCli(['help', '--lang', 'en', '--no-color'], { env: { GS_LANG: 'zh-CN' } });
  assert.equal(spaced.code, 0);
  assert.match(spaced.stdout, /Usage:/, '--lang en must beat GS_LANG=zh-CN');

  const equalled = await runCli(['help', '--lang=zh-CN', '--no-color'], { env: { GS_LANG: 'en' } });
  assert.equal(equalled.code, 0);
  assert.match(equalled.stdout, /用法/, '--lang=zh-CN must work in the `=` spelling');
});

test('--no-color removes ANSI escapes, and a non-TTY stream is never coloured', async () => {
  const h = await createTmpHome();
  try {
    await seed(h);
    // No `--no-color` below: stdout is a pipe (the test runner's), so a CLI that
    // respects the stream type colours nothing and the assertions still hold.
    const plain = await runCli(['list', '--home', h.home]);
    assert.equal(plain.code, 0, plain.stderr);
    assert.ok(
      !plain.stdout.includes(ANSI),
      'stdout is not a terminal here: colour must be disabled automatically so the output stays ' +
        'greppable and pipeable (no --no-color was passed)',
    );

    const piped = await runCli(['version', '--json']);
    assert.ok(!piped.stdout.includes(ANSI), 'a JSON document must never contain escape sequences');
  } finally {
    await h.cleanup();
  }
});

test('NO_COLOR is honoured for the plain text reports', async () => {
  const h = await createTmpHome();
  try {
    await seed(h);
    const result = await runCli(['list', '--home', h.home], { env: { NO_COLOR: '1' } });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!result.stdout.includes(ANSI), 'the NO_COLOR convention must switch colour off');
  } finally {
    await h.cleanup();
  }
});

/* ================================================================== */
/* add → list → diff → apply closed loop                               */
/* ================================================================== */

test('add then list then diff then apply is a closed loop', async () => {
  const h = await createTmpHome();
  try {
    await seedBare(h);
    const { mkdir } = await import('node:fs/promises');
    const project = path.join(h.home, 'code', 'newproj');
    await mkdir(project, { recursive: true });

    const added = await runCli(['add', project, '--identity', 'work', '--home', h.home, '--json', '--no-color']);
    const addData = parseJson(added, 'gs add');
    assert.equal(addData.identity, 'work');
    assert.equal(addData.dir, '~/code/newproj');

    const listed = await runCli(['list', '--home', h.home, '--json', '--no-color'], { cwd: project });
    const listData = parseJson(listed, 'gs list');
    const rules = listData.rules as { dir: string; identity: string }[];
    assert.deepEqual(rules, [{ dir: '~/code/newproj', identity: 'work' }]);
    assert.equal((listData.resolved as { identity: string }).identity, 'work', 'the directory resolves to the new rule');
    assert.match((listData.resolved as { reason: string }).reason, /rule/);

    const diffed = await runCli(['diff', '--home', h.home, '--json', '--no-color']);
    const diffData = parseJson(diffed, 'gs diff');
    assert.equal(diffData.dirty, true, 'diff must see the pending write');

    const first = await runCli(['apply', '--home', h.home, '--no-color']);
    assert.equal(first.code, 0, first.stdout + first.stderr);

    const gitconfig = await h.read('.gitconfig');
    assert.match(gitconfig, /gs:managed/, 'apply must write the managed block');
    assert.match(gitconfig, /includeIf/, 'apply must write the includeIf rules');

    const second = await runCli(['apply', '--home', h.home, '--json', '--no-color']);
    const applyData = parseJson(second, 'second gs apply');
    assert.deepEqual(applyData.written, [], 'a second apply must be a no-op');

    const afterDiff = await runCli(['diff', '--home', h.home, '--json', '--no-color']);
    const afterData = parseJson(afterDiff, 'gs diff after apply');
    assert.equal(afterData.dirty, false, 'nothing may be pending after apply');
  } finally {
    await h.cleanup();
  }
});

test('add is idempotent: the same rule twice keeps the rule count', async () => {
  const h = await createTmpHome();
  try {
    await seedBare(h);
    const { mkdir } = await import('node:fs/promises');
    const project = path.join(h.home, 'code', 'twice');
    await mkdir(project, { recursive: true });

    const first = await runCli(['add', project, '--identity', 'work', '--home', h.home, '--json', '--no-color']);
    const second = await runCli(['add', project, '--identity', 'work', '--home', h.home, '--json', '--no-color']);

    const a = parseJson(first, 'first gs add');
    const b = parseJson(second, 'second gs add');
    assert.equal(a.action, 'added');
    assert.equal(b.action, 'unchanged');
    assert.equal(b.rulesAfter, a.rulesAfter, 'adding the same rule twice must not duplicate it');
  } finally {
    await h.cleanup();
  }
});

test('re-binding a directory to another identity needs --force', async () => {
  const h = await createTmpHome();
  try {
    await seed(h);
    const project = path.join(h.home, 'code', 'work');
    const refused = await runCli(['add', project, '--identity', 'personal', '--home', h.home, '--no-color']);
    assert.equal(refused.code, 2, `re-binding without --force must exit 2, got ${refused.code}`);

    const forced = await runCli(['add', project, '--identity', 'personal', '--force', '--home', h.home, '--json', '--no-color']);
    const data = parseJson(forced, 'gs add --force');
    assert.equal(data.action, 'replaced');
    assert.equal(data.previousIdentity, 'work');
  } finally {
    await h.cleanup();
  }
});

/* ================================================================== */
/* flags that do not exist                                             */
/* ================================================================== */

test('a misspelled --dry-run actually applies, which a real --dry-run flag would prevent', async () => {
  const h = await createTmpHome();
  try {
    await seed(h);
    // Two identical invocations except for one dash. `--dry-run` writes nothing;
    // `--dryrun` is not a known flag. If unknown flags were rejected the typo
    // could never destroy anything.
    const dry = await runCli(['apply', '--dry-run', '--home', h.home, '--json', '--no-color']);
    assert.equal(dry.code, 0, dry.stdout + dry.stderr);
    assert.ok(!(await h.read('.gitconfig')).includes('gs:managed'), 'the correct spelling writes nothing');

    const typo = await runCli(['apply', '--dryrun', '--home', h.home, '--json', '--no-color']);
    const wroteAnyway = (await h.read('.gitconfig')).includes('gs:managed');
    assert.ok(
      typo.code === 2 || !wroteAnyway,
      'a misspelled flag must be rejected (exit 2); silently applying it defeats the entire purpose ' +
        `of --dry-run (exit=${typo.code}, wrote=${wroteAnyway})`,
    );
  } finally {
    await h.cleanup();
  }
});

test('an unknown flag does not quietly change what a command does', async () => {
  const h = await createTmpHome();
  try {
    await seed(h);
    // `--force` is not part of `list` or `diff`; passing it may be harmless, but
    // a completely invented flag must not make the command report success while
    // ignoring it. Any of "reject" (2) or "ignore and do the normal thing" is
    // acceptable; what is unacceptable is a success status with no work done.
    const result = await runCli(['list', '--home', h.home, '--json', '--no-color', '--nosuchflag']);
    if (result.code === 0) {
      const data = JSON.parse(result.stdout) as { identities: unknown[] };
      assert.equal(data.identities.length, 2, 'if an unknown flag is tolerated, the command must still do its job');
    } else {
      assert.equal(result.code, 2, 'rejecting an unknown flag is an error, not a warning');
    }
  } finally {
    await h.cleanup();
  }
});

test('an extra positional operand is not silently ignored', async () => {
  const h = await createTmpHome();
  try {
    await seed(h);
    // `gs diff xyz` — `diff` takes no operands. Accepting it and exiting 0 makes
    // `gs diff --json extra` look like it diffed something specific.
    const result = await runCli(['diff', 'unexpected-operand', '--home', h.home, '--no-color']);
    const acknowledged = /unexpected-operand/.test(result.stdout + result.stderr);
    assert.ok(
      result.code === 2 || acknowledged,
      `\`gs diff unexpected-operand\` exited ${result.code} without mentioning the extra operand; ` +
        'a trailing argument should be rejected or acknowledged, never silently dropped',
    );
  } finally {
    await h.cleanup();
  }
});

/* ================================================================== */
/* failures that are not validation errors                             */
/* ================================================================== */

test('a bad value for a numeric flag is a usage error (2), not a stack trace', async () => {
  const h = await createTmpHome();
  try {
    await seed(h);
    const result = await runCli(['gui', '--port', 'not-a-port', '--home', h.home, '--json', '--no-open', '--no-color']);
    assert.equal(result.code, 2, `a bad --port value must be a usage error, got ${result.code}`);
    assert.doesNotMatch(
      result.stderr,
      /^\s+at .*\(/m,
      `the user must not be shown an internal stack trace:\n${result.stderr}`,
    );
    assert.match(result.stdout + result.stderr, /port/i, 'the message has to name the offending option');
  } finally {
    await h.cleanup();
  }
});

test('a runtime failure still exits 2 and keeps the reason readable', async () => {
  const h = await createTmpHome();
  try {
    // ~/.config/gs/identities/w.gitconfig exists as a *directory*: planning can
    // still run, but nothing can be written there.
    await seedBare(h);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(h.home, '.config', 'gs', 'identities', 'work.gitconfig'), { recursive: true });

    const result = await runCli(['apply', '--home', h.home, '--json', '--no-color']);
    assert.equal(result.code, 2, `a failed apply must exit 2, got ${result.code}\n${result.stdout}`);
    assert.doesNotMatch(
      result.stderr,
      /^\s+at .*\(/m,
      `an unexpected error must be reported without a stack trace:\n${result.stderr}`,
    );
  } finally {
    await h.cleanup();
  }
});

test('a directory where a config file belongs never yields a silent success', async () => {
  const h = await createTmpHome();
  try {
    await seed(h);
    // ~/.ssh/config is a directory: neither planning nor writing can succeed.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(h.home, '.ssh', 'config'), { recursive: true });

    const result = await runCli(['apply', '--home', h.home, '--json', '--no-color']);
    assert.equal(result.code, 2, `apply could not use ~/.ssh/config but exited ${result.code}:\n${result.stdout}`);
    assert.doesNotMatch(result.stderr, /^\s+at .*\(/m, `no stack trace in the output:\n${result.stderr}`);
    // --json promises a document; if the run failed before any plan existed,
    // stdout legitimately stays empty — but never half-written.
    if (result.stdout.trim() !== '') {
      assert.doesNotThrow(() => JSON.parse(result.stdout), `stdout must be a whole JSON document:\n${result.stdout}`);
    }
  } finally {
    await h.cleanup();
  }
});

/* ================================================================== */
/* paths                                                               */
/* ================================================================== */

test('Windows and POSIX rule paths are both accepted and stored in POSIX form', async () => {
  const h = await createTmpHome();
  try {
    await seedBare(h);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(h.home, 'code', 'winstyle'), { recursive: true });
    await mkdir(path.join(h.home, 'code', 'posixstyle'), { recursive: true });

    // A backslash is a separator only on Windows. Elsewhere it is an ordinary
    // character in a file name, so `C:\…` is not an absolute path at all and the
    // form must not be expected to resolve — the check below is platform-specific
    // on purpose.
    if (process.platform === 'win32') {
      const winStyle = path.join(h.home, 'code', 'winstyle').replace(/\//g, '\\');
      const win = await runCli(['add', winStyle, '--identity', 'work', '--home', h.home, '--json', '--no-color']);
      const winData = parseJson(win, 'gs add (backslashes)');
      assert.equal(winData.dir, '~/code/winstyle', 'backslashes must normalise to the ~/… form');
    }

    const posix = await runCli([
      'add',
      `${h.home.replace(/\\/g, '/')}/code/posixstyle`,
      '--identity',
      'work',
      '--home',
      h.home,
      '--json',
      '--no-color',
    ]);
    const posixData = parseJson(posix, 'gs add (forward slashes)');
    assert.equal(posixData.dir, '~/code/posixstyle');

    const yaml = await h.read('.config/gs/profiles.yaml');
    assert.ok(!yaml.includes('\\\\'), `stored rules must use forward slashes only:\n${yaml}`);
  } finally {
    await h.cleanup();
  }
});

/* ================================================================== */
/* documentation drift                                                 */
/* ================================================================== */

test('the help screen lists every command the CLI dispatches', async () => {
  const help = await runCli(['help', '--lang', 'en', '--no-color']);
  assert.equal(help.code, 0);
  for (const command of ['init', 'list', 'add', 'diff', 'apply', 'doctor', 'gui', 'key', 'snapshot', 'help', 'version']) {
    assert.match(help.stdout, new RegExp(`^  ${command}\\b`, 'm'), `\`gs help\` must document \`${command}\``);
  }
});

test('the help screen documents the exit-code contract it follows', async () => {
  const help = await runCli(['help', '--lang', 'en', '--no-color']);
  assert.match(help.stdout, /Exit codes:\s*0\b.*\b1\b.*\b2\b/, `the exit codes must be spelled out:\n${help.stdout}`);

  const zh = await runCli(['help', '--lang', 'zh-CN', '--no-color']);
  assert.match(zh.stdout, /退出码/, 'the Chinese help must document them too');
});

test('every command the help documents is reachable', async () => {
  const h = await createTmpHome();
  try {
    await seedBare(h);
    // A command listed in help returning 2 *because it does not exist* would be
    // indistinguishable from one that legitimately errors, so check the message.
    const invocations: string[][] = [
      ['init', '--offline'],
      ['list'],
      ['add', h.home],
      ['diff'],
      ['apply', '--dry-run'],
      ['doctor'],
      ['key', 'list'],
      ['snapshot'],
      ['version'],
      ['help'],
    ];
    for (const args of invocations) {
      const result = await runCli([...args, '--home', h.home, '--no-color']);
      assert.ok(!/unknown command/i.test(result.stdout + result.stderr), `\`gs ${args.join(' ')}\` must be a real command`);
    }
  } finally {
    await h.cleanup();
  }
});

test('the README command table and `gs help` agree', async () => {
  const readme = await readFile(path.join(repoRoot, 'README.md'), 'utf8');
  const help = await runCli(['help', '--lang', 'en', '--no-color']);

  // Every `gs <word>` the README's command table advertises must be documented.
  const table = /## Commands[\s\S]*?(?=\n## )/.exec(readme);
  assert.ok(table, 'README.md must keep its Commands section');
  const advertised = new Set<string>();
  for (const line of table[0].split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cell = line.trim().split('|')[1] ?? '';
    const m = /`gs ([a-z]+)/.exec(cell);
    if (m?.[1]) advertised.add(m[1]);
  }
  assert.ok(advertised.size >= 8, `the table looks unparseable, found: ${[...advertised].join(',')}`);
  for (const command of advertised) {
    assert.match(
      help.stdout,
      new RegExp(`^  ${command}\\b`, 'm'),
      `README.md advertises \`gs ${command}\` but \`gs help\` does not list it`,
    );
  }
});

test('the README still states the exit-code contract the CLI implements', async () => {
  const readme = await readFile(path.join(repoRoot, 'README.md'), 'utf8');
  assert.match(readme, /Exit codes:\s*`0` ok · `1` warning · `2` error/);
  const zh = await readFile(path.join(repoRoot, 'README.zh-CN.md'), 'utf8');
  assert.match(zh, /退出码：`0` 成功 · `1` 警告 · `2` 错误/);
});
