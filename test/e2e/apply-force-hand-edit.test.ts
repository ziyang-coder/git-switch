import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTmpHome } from "../helpers/tmp-home.ts";

/**
 * `gs apply --force` and the managed-block hand-edit guard.
 *
 * The guard exists so `apply` never silently destroys a line the user typed
 * inside the block, and its error message tells the user how to proceed:
 * "Re-run with --force to overwrite". `gs help` documents `--force` as
 * "Overwrite managed blocks edited by hand". Both promises are checked here at
 * the CLI level, because that is the interface the user is promised.
 *
 * A user whose managed block was hand-edited is otherwise stuck: the error tells
 * them to re-run with --force, and if --force does not work the tool has no
 * documented escape hatch short of deleting the block by hand.
 */

const exec = promisify(execFile);
const here = path.dirname(
  new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
);
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "src", "cli.ts");

const posix = (p: string) => p.replace(/\\/g, "/");

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(
      process.execPath,
      ["--experimental-strip-types", cli, ...args],
      {
        cwd: repoRoot,
        windowsHide: true,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

function profile(home: string): string {
  return `schemaVersion: 1
identities:
  personal:
    user:
      name: alexchen
      email: alex@personal.example
rules:
  - dir: ${posix(home)}/code/personal
    identity: personal
`;
}

test("--force actually overwrites a managed block that was edited by hand", async () => {
  const h = await createTmpHome("gs-force-");
  try {
    await h.write(".config/gs/profiles.yaml", profile(h.home));
    await h.write(".gitconfig", "[user]\n\tname = base\n");

    const first = await runCli(["apply", "--home", h.home, "--no-color"]);
    assert.equal(first.code, 0, first.stdout + first.stderr);

    const text = await h.read(".gitconfig");
    await h.write(
      ".gitconfig",
      text.replace("# >>> gs:managed >>>", "# >>> gs:managed >>>\n# my note"),
    );

    // Without --force the edit is protected and the user is told how to proceed.
    const refused = await runCli(["apply", "--home", h.home, "--no-color"]);
    assert.equal(
      refused.code,
      2,
      `a hand edit must block apply:\n${refused.stdout}${refused.stderr}`,
    );
    assert.match(
      refused.stdout + refused.stderr,
      /--force/,
      "the error must offer --force as the way out",
    );
    assert.ok(
      (await h.read(".gitconfig")).includes("# my note"),
      "the edit survives a refused apply",
    );

    // With --force the documented behaviour is to overwrite.
    const forced = await runCli([
      "apply",
      "--force",
      "--home",
      h.home,
      "--no-color",
    ]);
    assert.equal(
      forced.code,
      0,
      "the error above tells the user to re-run with --force and `gs help` documents it as " +
        `"overwrite managed blocks edited by hand", so --force must not also be refused:\n` +
        `${forced.stdout}${forced.stderr}`,
    );
    const after = await h.read(".gitconfig");
    assert.ok(
      !after.includes("# my note"),
      "--force must replace the hand-edited block",
    );
    assert.ok(
      after.includes("gs:managed"),
      "the managed block must be regenerated",
    );

    // And a following plain apply is a clean no-op again.
    const settled = await runCli([
      "apply",
      "--home",
      h.home,
      "--lang",
      "en",
      "--no-color",
    ]);
    assert.equal(
      settled.code,
      0,
      `apply must be idempotent after --force:\n${settled.stdout}${settled.stderr}`,
    );
    assert.match(
      settled.stdout,
      /no changes/i,
      "the second apply must report that nothing changed",
    );
  } finally {
    await h.cleanup();
  }
});

test("--force, not deleting the block by hand, is the escape hatch for ~/.ssh/config too", async () => {
  const h = await createTmpHome("gs-force-");
  try {
    await h.write(
      ".config/gs/profiles.yaml",
      `schemaVersion: 1
identities:
  personal:
    user:
      name: alexchen
      email: alex@personal.example
    sshKey: id_ed25519_github
    sites:
      - host: github.com
        alias: gh
rules: []
`,
    );
    await h.write(".ssh/config", "Host keepme\n\tHostName keep.example\n");
    await h.write(
      ".ssh/id_ed25519_github",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n",
    );

    const first = await runCli(["apply", "--home", h.home, "--no-color"]);
    assert.equal(first.code, 0, first.stdout + first.stderr);
    const text = await h.read(".ssh/config");
    await h.write(
      ".ssh/config",
      text.replace("Host gh", "Host gh\n\tProxyJump bastion.example"),
    );

    const refused = await runCli(["apply", "--home", h.home, "--no-color"]);
    assert.equal(
      refused.code,
      2,
      `the hand edit must be protected:\n${refused.stdout}${refused.stderr}`,
    );
    assert.ok(
      (await h.read(".ssh/config")).includes("ProxyJump bastion.example"),
    );

    const forced = await runCli([
      "apply",
      "--force",
      "--home",
      h.home,
      "--no-color",
    ]);
    assert.equal(
      forced.code,
      0,
      `--force must overwrite the edited managed block:\n${forced.stdout}${forced.stderr}`,
    );
    const after = await h.read(".ssh/config");
    assert.ok(
      !after.includes("ProxyJump bastion.example"),
      "the hand edit is replaced by the generated block",
    );
    assert.ok(
      after.includes("Host keepme"),
      "content outside the managed block must be preserved",
    );
  } finally {
    await h.cleanup();
  }
});

test("dry-run still reports the pending change while a real apply is blocked", async () => {
  const h = await createTmpHome("gs-force-");
  try {
    await h.write(".config/gs/profiles.yaml", profile(h.home));
    await h.write(".gitconfig", "");
    const first = await runCli(["apply", "--home", h.home, "--no-color"]);
    assert.equal(first.code, 0, first.stdout + first.stderr);
    const text = await h.read(".gitconfig");
    await h.write(
      ".gitconfig",
      text.replace("# >>> gs:managed >>>", "# >>> gs:managed >>>\n# note"),
    );

    // dry-run describes what apply would do; the hand edit has to be visible as
    // an error rather than a silent "nothing to do".
    const dry = await runCli([
      "apply",
      "--dry-run",
      "--home",
      h.home,
      "--json",
      "--no-color",
    ]);
    const body =
      dry.stdout.trim() === ""
        ? undefined
        : (JSON.parse(dry.stdout) as { errors?: string[] });
    assert.ok(
      body,
      `--dry-run --json must emit a document:\n${dry.stdout}${dry.stderr}`,
    );
    assert.ok(
      (body.errors ?? []).some((e) => /edits gs did not generate/.test(e)),
      `--dry-run must report the hand edit instead of hiding it:\n${dry.stdout}`,
    );
    assert.ok(
      (await h.read(".gitconfig")).includes("# note"),
      "--dry-run must not write",
    );
  } finally {
    await h.cleanup();
  }
});
