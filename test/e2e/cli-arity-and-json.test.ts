/**
 * Second-order contract of the CLI argument parser and of `--json` failure output.
 *
 * `cli-contract.test.ts` covers the headline cases. The cases here are the ones
 * the parser's tables and the JSON-failure promise leave ambiguous:
 *
 *  - `POSITIONAL_ARITY` allows up to two positionals for `key` and `snapshot`,
 *    because the qualified form is `gs key gen NAME`. That budget hides a bad
 *    operand on the *unqualified* subcommands (`gs key list EXTRA`), which is
 *    the same silent-drop defect the arity fix was written to remove.
 *  - `--json` promises a JSON document. Plan errors produce one, but a profile
 *    that cannot be loaded exits 2 with an empty stdout, so a script parsed
 *    against `--json` gets nothing to read.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createTmpHome,
  PROFILE_GITHUB_GITEE,
  type TmpHome,
} from "../helpers/tmp-home.ts";

const exec = promisify(execFile);
const here = path.dirname(
  new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
);
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "src", "cli.ts");

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

async function seed(): Promise<TmpHome> {
  const h = await createTmpHome("gs-cli2-");
  const home = h.home.replace(/\\/g, "/");
  await h.write(
    ".config/gs/profiles.yaml",
    PROFILE_GITHUB_GITEE.replaceAll("__HOME__", home),
  );
  await h.write(".gitconfig", "");
  return h;
}

/* ------------------------------------------------------------------ */
/* Positional arity of the unqualified subcommands                     */
/* ------------------------------------------------------------------ */

test("an extra operand after `key list` is rejected, not silently dropped", async () => {
  const h = await seed();
  try {
    // `key` allows two positionals for `gs key gen NAME`; that budget must not
    // let `gs key list TYPO` succeed as if TYPO had been understood.
    const result = await runCli([
      "key",
      "list",
      "unexpected-operand",
      "--home",
      h.home,
      "--json",
      "--no-color",
    ]);
    const acknowledged = /unexpected-operand/.test(
      result.stdout + result.stderr,
    );
    assert.ok(
      result.code === 2 || acknowledged,
      "`gs key list` takes no operand; a stray one must be rejected (exit 2) or at least named, " +
        `but it exited ${result.code} and vanished:\n${result.stdout}${result.stderr}`,
    );
  } finally {
    await h.cleanup();
  }
});

test("an extra operand after a two-word subcommand is still rejected", async () => {
  const h = await seed();
  try {
    // `gs snapshot export FILE EXTRA` is the bounded case and already works;
    // keep it pinned so a future relaxation of the table cannot regress it.
    const result = await runCli([
      "snapshot",
      "export",
      "f.gsnap",
      "extra",
      "--home",
      h.home,
      "--no-color",
    ]);
    assert.equal(
      result.code,
      2,
      `an extra operand must exit 2:\n${result.stdout}${result.stderr}`,
    );
    assert.match(result.stdout + result.stderr, /extra/);
  } finally {
    await h.cleanup();
  }
});

test("every documented command still parses with its documented operands", async () => {
  const h = await seed();
  try {
    // These assert the parser accepts the documented shape. `doctor` may
    // legitimately exit 2 in a fixture without key files, so only the commands
    // that must succeed here are checked for exit 0.
    const cases: { args: string[]; what: string; ok: boolean }[] = [
      { args: ["list"], what: "gs list", ok: true },
      { args: ["diff"], what: "gs diff", ok: true },
      { args: ["doctor"], what: "gs doctor", ok: false },
      { args: ["key", "list"], what: "gs key list", ok: true },
      { args: ["key"], what: "gs key (defaults to list)", ok: true },
      {
        args: ["snapshot", "export", path.join(h.home, "out.gsnap")],
        what: "gs snapshot export FILE",
        ok: true,
      },
      {
        args: [
          "add",
          path.join(h.home, "code", "extra"),
          "--identity",
          "personal",
          "--dry-run",
        ],
        what: "gs add DIR --identity",
        ok: true,
      },
    ];
    for (const { args, what, ok } of cases) {
      const result = await runCli([...args, "--home", h.home, "--no-color"]);
      assert.ok(
        !/unknown option|unexpected argument|missing value/.test(
          result.stdout + result.stderr,
        ),
        `${what} must parse:\n${result.stdout}${result.stderr}`,
      );
      if (ok)
        assert.equal(
          result.code,
          0,
          `${what} must keep working:\n${result.stdout}${result.stderr}`,
        );
    }
  } finally {
    await h.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* --json on failure paths                                             */
/* ------------------------------------------------------------------ */

test("--json emits a document when the profile itself cannot be loaded", async () => {
  const h = await createTmpHome("gs-cli2-");
  try {
    // No profile at all: the most common automation failure (wrong --home).
    for (const command of ["list", "diff", "apply", "doctor"]) {
      const result = await runCli([
        command,
        "--home",
        h.home,
        "--json",
        "--no-color",
      ]);
      assert.equal(
        result.code,
        2,
        `gs ${command} on a missing profile must exit 2, got ${result.code}`,
      );
      let parsed: unknown;
      assert.doesNotThrow(() => {
        parsed = JSON.parse(result.stdout);
      }, `--json promises a JSON document, but gs ${command} wrote nothing to stdout:\n${result.stdout}\nstderr: ${result.stderr}`);
      assert.equal(
        typeof parsed,
        "object",
        `gs ${command} --json must emit an object`,
      );
    }
  } finally {
    await h.cleanup();
  }
});

test("--json emits a document when the profile on disk is malformed", async () => {
  const h = await createTmpHome("gs-cli2-");
  try {
    await h.write(
      ".config/gs/profiles.yaml",
      "schemaVersion: 1\nidentities: [oops\n",
    );
    for (const command of ["list", "apply"]) {
      const result = await runCli([
        command,
        "--home",
        h.home,
        "--json",
        "--no-color",
      ]);
      assert.equal(
        result.code,
        2,
        `a malformed profile must exit 2, got ${result.code}`,
      );
      let parsed: unknown;
      assert.doesNotThrow(() => {
        parsed = JSON.parse(result.stdout);
      }, `--json promises a JSON document, but gs ${command} wrote nothing to stdout:\n${result.stdout}\nstderr: ${result.stderr}`);
      assert.equal(
        typeof parsed,
        "object",
        `gs ${command} --json must emit an object`,
      );
    }
  } finally {
    await h.cleanup();
  }
});

test("the failure document says what went wrong", async () => {
  const h = await createTmpHome("gs-cli2-");
  try {
    const result = await runCli([
      "list",
      "--home",
      h.home,
      "--json",
      "--no-color",
    ]);
    assert.equal(result.code, 2);
    const body = JSON.parse(result.stdout) as {
      error?: string;
      errors?: string[];
    };
    const text = JSON.stringify(body);
    // either channel is acceptable as long as the reason survives into the document
    assert.match(
      text,
      /profile/i,
      `the JSON document must explain the failure, got: ${text}`,
    );
  } finally {
    await h.cleanup();
  }
});
