#!/usr/bin/env node
/**
 * Test runner with a floor.
 *
 * `node --test <glob>` exits 0 with "tests 0" when the glob matches nothing, so
 * CI would go green on a checkout where the tests were accidentally not present.
 * This wrapper runs the suite and fails if the reported test count is below a
 * minimum, keeping the gate honest.
 *
 * The floor is PER PLATFORM. Some suites skip cases that cannot work elsewhere —
 * POSIX mode bits on Windows, Windows ACLs on POSIX, `gitdir:` case folding on
 * Linux — so the totals legitimately differ. A single number taken from the
 * developer's machine makes every other runner fail; that is exactly what
 * happened when 806 (Windows) was enforced on Linux, which runs 802.
 */

import { spawn } from 'node:child_process';

/**
 * Minimum test counts per platform.
 *
 * These are deliberately a few below the measured totals, because the exact
 * number depends on the runner: `permissions` skips POSIX mode bits on Windows
 * and ACL checks elsewhere, `failures` skips three cases on Windows,
 * `case-sensitivity` skips two on Linux, and `snapshot-path-containment` skips
 * when the machine cannot create directory links (Windows without elevation) or
 * runs as root.
 *
 * The gate exists to catch "the suite silently stopped running", not to pin an
 * exact number, so a small margin is correct; a single hard-coded number taken
 * from one developer's machine is not.
 */
const FLOOR_BY_PLATFORM = {
  win32: 801,
  darwin: 796,
  linux: 796,
};

const platformFloor = FLOOR_BY_PLATFORM[process.platform];
const MIN_TESTS = Number.parseInt(
  process.env.GS_MIN_TESTS ?? String(platformFloor ?? FLOOR_BY_PLATFORM.win32),
  10,
);

if (platformFloor === undefined && process.env.GS_MIN_TESTS === undefined) {
  // An unknown platform still gets a gate, but a lenient one: fewer cases are
  // guaranteed to run somewhere we have never measured.
  console.warn(`\nunmeasured platform "${process.platform}" — using the lowest known floor`);
}

const patterns = process.argv.slice(2);

if (patterns.length === 0) {
  console.error('usage: node scripts/run-tests.mjs <glob> [glob...]');
  process.exit(2);
}

/**
 * Environment every test process inherits.
 *
 * The suites drive the real `git` binary against temporary repositories. On CI
 * the workspace is checked out by one user while the temp homes belong to
 * another, and git then refuses to touch those repositories with "detected
 * dubious ownership" — every git-backed test fails. Ubuntu happens to run as the
 * same user, which is why only that job stayed green.
 *
 * Setting `safe.directory=*` through the environment covers both the tests' own
 * git calls and the ones the library makes with `process.env`.
 */
const TEST_ENV = {
  ...process.env,
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'safe.directory',
  GIT_CONFIG_VALUE_0: '*',
  // a pager or an interactive prompt would hang a headless runner
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
};

const child = spawn(
  process.execPath,
  ['--experimental-strip-types', '--test', ...patterns],
  { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, env: TEST_ENV },
);

let buffer = '';
const forward = (chunk) => {
  buffer += chunk.toString();
  process.stdout.write(chunk);
};
child.stdout.on('data', forward);

/**
 * The names of failing tests, scraped from the TAP output.
 *
 * CI logs get truncated and scrolled; printing the list at the very end means the
 * last few lines of a failing job already say what broke, without having to dig
 * for the `not ok` line in hundreds of passing ones.
 */
function failedTestNames(output) {
  const names = [];
  for (const match of output.matchAll(/^not ok \d+ - (.+?)(?: # SKIP.*)?$/gm)) {
    names.push(match[1]);
  }
  return names;
}

child.on('close', (code) => {
  const match = /# tests (\d+)/.exec(buffer) ?? /tests (\d+)/.exec(buffer);
  const total = match ? Number.parseInt(match[1], 10) : 0;

  if (code !== 0) {
    const failures = failedTestNames(buffer);
    console.error(`\n${'-'.repeat(70)}`);
    if (failures.length > 0) {
      console.error(`${failures.length} failing test(s) on ${process.platform}, node ${process.version}:`);
      for (const name of failures) console.error(`  ✗ ${name}`);
    } else {
      console.error(`the test process exited ${code} on ${process.platform}, node ${process.version}`);
      // a crash before any test ran leaves no `not ok`; show the tail instead
      console.error('last output:\n' + buffer.split('\n').slice(-15).join('\n'));
    }
    console.error(`${'-'.repeat(70)}\n`);
    process.exit(code ?? 1);
  }
  if (total < MIN_TESTS) {
    console.error(
      `\ntest floor not met: ran ${total} tests on ${process.platform}, expected at least ${MIN_TESTS}. ` +
        `If the suite legitimately shrank, update FLOOR_BY_PLATFORM or set GS_MIN_TESTS.`,
    );
    process.exit(1);
  }
  console.log(
    `\ntest floor satisfied: ${total} tests on ${process.platform} (minimum ${MIN_TESTS})`,
  );
});
