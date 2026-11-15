/**
 * Running real git inside a throw-away home.
 *
 * The tests drive the actual `git` binary with HOME redirected, because the whole
 * point of `gs` is what git ends up reading. Three settings have to travel with
 * every invocation, and getting any of them wrong shows up as opaque failures:
 *
 *  - `HOME` / `USERPROFILE` — so git reads the temp `~/.gitconfig`, not the
 *    developer's.
 *  - `GIT_CONFIG_NOSYSTEM=1` — so a system-wide config cannot interfere.
 *  - `safe.directory=*` — git refuses to operate on a repository it thinks is
 *    owned by someone else. GitHub Actions checks out the workspace as one user
 *    and the temp home is owned by another, so on Windows and macOS runners every
 *    `git init` / `git status` fails with "detected dubious ownership". Ubuntu is
 *    permissive here, which is why the same suite was green there and red
 *    everywhere else.
 *
 * `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` inject the setting
 * through the environment, so nothing has to be written into the profile under
 * test.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitEnvOptions {
  /** The temp home git should treat as `~`. */
  home: string;
  /** Extra environment entries layered on top. */
  extra?: NodeJS.ProcessEnv;
}

/** Environment that makes real git behave predictably inside `home`. */
export function gitEnv({ home, extra }: GitEnvOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_GLOBAL: `${home}/.gitconfig`,
    GIT_CONFIG_NOSYSTEM: '1',
    // ignore ownership checks for the throw-away repositories
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '*',
    // keep the output free of localisation and pager differences
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    ...extra,
  };
}

/** Run git in `cwd` with the throw-away home applied. Returns stdout. */
export async function runGit(
  home: string,
  cwd: string,
  args: string[],
  extra?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: gitEnv({ home, ...(extra !== undefined ? { extra } : {}) }),
      windowsHide: true,
    });
    return stdout;
  } catch (err) {
    // Surface what git actually said: a bare "Command failed" hides the reason
    const e = err as { stderr?: string; stdout?: string; code?: number };
    const detail = (e.stderr ?? e.stdout ?? '').trim();
    throw new Error(`git ${args.join(' ')} failed in ${cwd}${detail ? `: ${detail}` : ''}`);
  }
}

/** Create a repository at `dir` under the throw-away home. */
export async function initRepo(home: string, dir: string): Promise<void> {
  await runGit(home, dir, ['init', '-q']);
  // an identity, so commits and config lookups do not depend on the runner
  await runGit(home, dir, ['config', 'user.name', 'Test']);
  await runGit(home, dir, ['config', 'user.email', 'test@example.com']);
}
