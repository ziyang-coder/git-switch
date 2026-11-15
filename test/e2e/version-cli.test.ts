import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const PKG_NAME = JSON.parse(
  (await import('node:fs')).readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).name as string;
const run = promisify(execFile);
const cli = path.resolve('src/cli.ts');

async function gs(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], { windowsHide: true });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/**
 * `gs version` must stay scriptable.
 *
 * `gs --version` is what CI jobs and shell scripts call, so it has to print one
 * line and nothing else. `--version` used to be swallowed as a flag, which made
 * it print the whole help screen instead.
 */

test('gs --version prints a single line and nothing else', async () => {
  const result = await gs(['--version']);
  assert.equal(result.code, 0);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `expected one line, got: ${result.stdout}`);
  assert.match(lines[0] ?? '', /^\d+\.\d+\.\d+/);
});

test('gs version --short prints only the version', async () => {
  const result = await gs(['version', '--short']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim().split('\n').length, 1);
});

test('gs version shows the author and the licence', async () => {
  const result = await gs(['version', '--no-color']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /CodeMonkeyJust/);
  assert.match(result.stdout, /MIT/);

  const lines = result.stdout.trim().split('\n');
  assert.ok(lines.length >= 4, `expected metadata lines, got: ${result.stdout}`);
  // the first line must remain just the version, so `| head -1` still works
  assert.match(lines[0] ?? '', /^\d+\.\d+\.\d+\S*$/, 'the first line is the bare version');
});

test('gs version --json is machine readable', async () => {
  const result = await gs(['version', '--json']);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout) as {
    version: string;
    package: { name: string; author?: string; license?: string };
    build: { channel: string; builtAt: string };
  };
  assert.ok(parsed.version.length > 0);
  assert.equal(parsed.package.name, PKG_NAME);
  assert.ok(parsed.package.author);
  assert.ok(['release', 'dev'].includes(parsed.build.channel));
});

test('gs --help still prints the help screen', async () => {
  const result = await gs(['--help', '--lang', 'en']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /Commands:/);
});

test('help documents the add command', async () => {
  const result = await gs(['help', '--lang', 'en']);
  assert.match(result.stdout, /add \[dir\] --identity/);
});
