import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createTmpHome } from "../helpers/tmp-home.ts";
import { plan } from "../../src/core/plan.ts";
import { parseProfilesText, loadProfiles } from "../../src/core/profiles.ts";
import {
  BEGIN_MARKER,
  END_MARKER,
  findBlock,
} from "../../src/core/managed-block.ts";
import type { Profiles } from "../../src/core/model.ts";

/**
 * `plan()` is the read-only half of `gs apply`: it reads the current files and
 * describes what would change. Its job makes two promises to the user:
 *
 *   - it never writes (the CLI shows the diff and asks nothing further);
 *   - it never crashes on a user's real files — a half-edited managed block or
 *     an unreadable config becomes an entry in `plan.errors`, not a stack trace.
 *
 * The successful diffs are covered by `render.test.ts` and the e2e suite; the
 * tests here target the failure modes and the "no file is touched" guarantee.
 */

const posix = (p: string) => p.replace(/\\/g, "/");

function profilesFor(home: string, extra = ""): Profiles {
  return parseProfilesText(
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
rules:
  - dir: ${posix(home)}/code
    identity: personal
${extra}
`,
    home,
  );
}

/* ------------------------------------------------------------------ */
/* plan is read-only                                                   */
/* ------------------------------------------------------------------ */

test("plan never creates or modifies a file", async () => {
  const h = await createTmpHome();
  try {
    await h.write(".gitconfig", "[user]\n\tname = me\n");
    await h.write(
      ".ssh/config",
      "Host existing\n\tHostName existing.example\n",
    );
    const before = {
      gitconfig: await h.read(".gitconfig"),
      ssh: await h.read(".ssh/config"),
      profilesList: await h.exists(".config/gs/profiles.yaml"),
      identities: await h.exists(".config/gs/identities"),
    };

    const result = await plan({ home: h.home, profiles: profilesFor(h.home) });
    assert.ok(result.dirty, "a first run has pending changes");
    assert.equal(result.errors.length, 0);

    assert.equal(
      await h.read(".gitconfig"),
      before.gitconfig,
      "~/.gitconfig is untouched",
    );
    assert.equal(
      await h.read(".ssh/config"),
      before.ssh,
      "~/.ssh/config is untouched",
    );
    assert.equal(
      await h.exists(".config/gs/profiles.yaml"),
      before.profilesList,
    );
    assert.equal(
      await h.exists(".config/gs/identities"),
      before.identities,
      "the identity config is not written",
    );
  } finally {
    await h.cleanup();
  }
});

test("plan on a fresh home proposes a block for every managed file and does not touch the disk", async () => {
  const h = await createTmpHome();
  try {
    const result = await plan({ home: h.home, profiles: profilesFor(h.home) });
    // The global/ssh configs are absent, so the reader returns "", and a plan
    // that writes a managed block into an empty file is reported as `update`
    // (before: "") rather than `create`. Only the per-identity config is a real
    // `create`, because its before is `undefined`. Pinned as-is.
    const byScope = Object.fromEntries(result.ops.map((o) => [o.scope, o]));
    assert.equal(byScope["global-gitconfig"]?.kind, "update");
    assert.equal(byScope["ssh-config"]?.kind, "update");
    assert.equal(byScope["identity-config"]?.kind, "create");
    assert.equal(result.dirty, true);
    for (const op of result.ops) {
      assert.equal(
        typeof op.after,
        "string",
        `${op.scope} must describe the new content`,
      );
    }
    // nothing was created
    assert.equal(await h.exists(".gitconfig"), false);
    assert.equal(await h.exists(".ssh"), false);
    assert.equal(await h.exists(".config/gs/identities"), false);
  } finally {
    await h.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* idempotency                                                         */
/* ------------------------------------------------------------------ */

test("planning twice against the files it proposed reports no changes", async () => {
  // This is the property that makes `gs apply` safe to run repeatedly: the second
  // run must see its own output as already up to date.
  const h = await createTmpHome();
  try {
    const profiles = profilesFor(h.home);
    const first = await plan({ home: h.home, profiles });
    assert.ok(first.dirty);

    const files = new Map(
      first.ops
        .filter((o) => o.after !== undefined)
        .map((o) => [o.file, o.after as string]),
    );
    const second = await plan({
      home: h.home,
      profiles,
      readFile: async (file) => files.get(file),
    });
    assert.equal(
      second.dirty,
      false,
      `still dirty: ${JSON.stringify(second.ops.map((o) => [o.kind, o.scope]))}`,
    );
    for (const op of second.ops) assert.equal(op.kind, "unchanged", op.scope);
  } finally {
    await h.cleanup();
  }
});

test("a real apply followed by a plan reports no changes", async () => {
  // Round trip through the actual filesystem rather than an injected reader.
  const h = await createTmpHome();
  try {
    await h.write(".gitconfig", "[user]\n\tname = me\n");
    const profiles = profilesFor(h.home);
    const first = await plan({ home: h.home, profiles });
    const { apply } = await import("../../src/core/apply.ts");
    const result = await apply(first, { home: h.home });
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));

    const reloaded = await loadProfiles(h.home).catch(() => undefined);
    // the profile file itself is not written by apply, so reload is expected to
    // fail; the point here is only that the disk state now matches the plan.
    const second = await plan({ home: h.home, profiles });
    assert.equal(
      second.dirty,
      false,
      `after apply, still dirty: ${JSON.stringify(second.ops.map((o) => o.kind))}`,
    );
    assert.equal(reloaded, undefined);
  } finally {
    await h.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* preserved bytes                                                     */
/* ------------------------------------------------------------------ */

test("user content and CRLF line endings survive the planned rewrite", async () => {
  const h = await createTmpHome();
  try {
    const userBlock =
      "# my own settings\r\nHost mine\r\n\tHostName mine.example\r\n";
    await h.write(".gitconfig", "[user]\r\n\tname = me\r\n");
    await h.write(".ssh/config", userBlock);

    const result = await plan({ home: h.home, profiles: profilesFor(h.home) });
    const ssh = result.ops.find((o) => o.scope === "ssh-config");
    assert.ok(ssh, "an ssh config op exists");
    assert.ok(
      (ssh.after ?? "").startsWith(userBlock),
      "the user block is byte-identical",
    );
    assert.ok(
      !/(?<!\r)\n/.test(ssh.after ?? ""),
      "the generated block uses CRLF too",
    );

    const git = result.ops.find((o) => o.scope === "global-gitconfig");
    assert.equal(
      git?.kind,
      "update",
      "the gs block is appended to the existing file",
    );
    // The [user] section is not inside the managed block: gs appends its block
    // after it and leaves the section itself untouched.
    assert.ok(
      (git?.after ?? "").startsWith("[user]\r\n\tname = me\r\n"),
      "the existing [user] section is kept verbatim",
    );
    assert.ok(
      !/(?<!\r)\n/.test(git?.after ?? ""),
      "the existing file keeps its CRLF",
    );
  } finally {
    await h.cleanup();
  }
});

test("an includeIf outside the gs block is reported, not rewritten", async () => {
  const h = await createTmpHome();
  try {
    const foreign =
      '[includeIf "gitdir:/legacy/"]\n\tpath = ~/.gitconfig-legacy\n';
    await h.write(".gitconfig", foreign);
    const result = await plan({ home: h.home, profiles: profilesFor(h.home) });
    const warning = result.warnings.find((w) => w.includes("includeIf"));
    assert.ok(
      warning,
      `no warning about the foreign includeIf: ${JSON.stringify(result.warnings)}`,
    );
    assert.match(warning, /will not modify them/);
    const git = result.ops.find((o) => o.scope === "global-gitconfig");
    assert.ok(
      (git?.after ?? "").startsWith(foreign),
      "the foreign entry is kept verbatim",
    );
  } finally {
    await h.cleanup();
  }
});

test("a Host entry outside the block that shadows a generated alias is reported", async () => {
  const h = await createTmpHome();
  try {
    await h.write(".ssh/config", "Host gh\n\tHostName my-own.example\n");
    const result = await plan({ home: h.home, profiles: profilesFor(h.home) });
    const warning = result.warnings.find((w) => w.includes("Host gh"));
    assert.ok(warning, JSON.stringify(result.warnings));
    // casing in the user's file does not hide the shadowing
    assert.match(warning, /first match/);
  } finally {
    await h.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* broken input becomes an error, not a crash                          */
/* ------------------------------------------------------------------ */

test("a half-deleted gs block becomes a plan error instead of a throw", async () => {
  const h = await createTmpHome();
  try {
    await h.write(".gitconfig", `${BEGIN_MARKER}\nstale content\n`);
    const result = await plan({ home: h.home, profiles: profilesFor(h.home) });
    assert.equal(result.errors.length, 1, JSON.stringify(result.errors));
    assert.match(result.errors[0] ?? "", /\.gitconfig/);
    assert.match(result.errors[0] ?? "", /BEGIN marker without END marker/);
    // the remaining files are still planned, so one broken file does not hide the rest
    assert.ok(result.ops.some((o) => o.scope === "ssh-config"));
    assert.ok(result.ops.some((o) => o.scope === "identity-config"));
  } finally {
    await h.cleanup();
  }
});

test("a half-deleted block in ~/.ssh/config is reported against that file", async () => {
  const h = await createTmpHome();
  try {
    await h.write(".ssh/config", `${END_MARKER}\n`);
    const result = await plan({ home: h.home, profiles: profilesFor(h.home) });
    assert.equal(result.errors.length, 1, JSON.stringify(result.errors));
    assert.match(result.errors[0] ?? "", /\.ssh\/config/);
  } finally {
    await h.cleanup();
  }
});

test("two managed blocks in one file are reported rather than merged", async () => {
  const h = await createTmpHome();
  try {
    await h.write(
      ".gitconfig",
      `${BEGIN_MARKER}\na\n${END_MARKER}\n${BEGIN_MARKER}\nb\n${END_MARKER}\n`,
    );
    const result = await plan({ home: h.home, profiles: profilesFor(h.home) });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0] ?? "", /more than one BEGIN marker/);
  } finally {
    await h.cleanup();
  }
});

test("an unreadable target file becomes a plan error instead of rejecting plan()", async () => {
  // REGRESSION TEST for a real defect. plan.ts (lines 72, 92, 105) awaits
  // `read(file)` OUTSIDE the try/catch that converts render failures into
  // `plan.errors`. readFileIfExists re-throws every error except ENOENT, so an
  // unreadable ~/.gitconfig escapes as a rejected promise: `gs diff` and
  // `gs apply` die with a raw EISDIR/EACCES instead of reporting which file is
  // unreadable and continuing with the rest.
  //
  // Expected: a Plan whose `errors` names the file.
  // Actual:   plan() rejects with the raw fs error.
  //
  // A directory where a file is expected is the portable way to produce a
  // non-ENOENT read error (works on Windows and POSIX alike).
  const h = await createTmpHome();
  try {
    await (
      await import("node:fs/promises")
    ).mkdir(path.join(h.home, ".gitconfig"), { recursive: true });
    const result = await plan({ home: h.home, profiles: profilesFor(h.home) });
    assert.equal(result.errors.length, 1, JSON.stringify(result.errors));
    assert.match(result.errors[0] ?? "", /\.gitconfig/);
  } finally {
    await h.cleanup();
  }
});

test("an injected readFile failure becomes a plan error, not a rejection", async () => {
  // Same defect as above, expressed through the documented test hook: the
  // `readFile` option exists so callers can simulate exactly this.
  const h = await createTmpHome();
  try {
    const result = await plan({
      home: h.home,
      profiles: profilesFor(h.home),
      readFile: async () => {
        throw new Error("simulated read failure");
      },
    });
    assert.equal(
      result.errors.length,
      3,
      `every managed file that could not be read is reported: ${JSON.stringify(result.errors)}`,
    );
    assert.ok(result.errors.every((e) => /simulated read failure/.test(e)));
    assert.ok(
      result.errors.some((e) => e.includes('.gitconfig')),
      'the user is told which file failed',
    );
  } finally {
    await h.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* labels and paths                                                    */
/* ------------------------------------------------------------------ */

test("every op carries a home-contracted label and an absolute file path", async () => {
  const h = await createTmpHome();
  try {
    const result = await plan({ home: h.home, profiles: profilesFor(h.home) });
    assert.equal(result.ops.length, 3, "one op per managed file");
    for (const op of result.ops) {
      assert.ok(path.isAbsolute(op.file), `${op.file} is not absolute`);
      assert.ok(
        op.label.startsWith("~"),
        `label is not contracted: ${op.label}`,
      );
      assert.ok(
        op.label.length > 1,
        `label is empty: ${JSON.stringify(op.label)}`,
      );
    }
    const labels = result.ops.map((o) => o.label).sort();
    assert.deepEqual(
      labels,
      [
        "~/.config/gs/identities/personal.gitconfig",
        "~/.gitconfig",
        "~/.ssh/config",
      ].sort(),
    );
  } finally {
    await h.cleanup();
  }
});

test("a missing key produces a warning naming the identity and the key", async () => {
  const h = await createTmpHome();
  try {
    const result = await plan({ home: h.home, profiles: profilesFor(h.home) });
    const warning = result.warnings.find((w) =>
      w.includes("id_ed25519_github"),
    );
    assert.ok(warning, JSON.stringify(result.warnings));
    assert.match(warning, /"personal"/, "the identity is named");
    assert.match(warning, /does not exist/);
    assert.match(
      warning,
      /github\.com/,
      "the site that needs the key is named",
    );
  } finally {
    await h.cleanup();
  }
});

test("a key that exists produces no missing-key warning", async () => {
  const h = await createTmpHome();
  try {
    await h.write(".ssh/id_ed25519_github", "KEY");
    const result = await plan({ home: h.home, profiles: profilesFor(h.home) });
    assert.equal(
      result.warnings.some((w) => w.includes("does not exist")),
      false,
      JSON.stringify(result.warnings),
    );
  } finally {
    await h.cleanup();
  }
});

test("the planned ssh block is a single well-formed managed block", async () => {
  const h = await createTmpHome();
  try {
    const result = await plan({ home: h.home, profiles: profilesFor(h.home) });
    const ssh = result.ops.find((o) => o.scope === "ssh-config");
    const block = findBlock(ssh?.after ?? "");
    assert.equal(block.present, true);
    assert.equal((ssh?.after ?? "").match(/gs:managed >>>/g)?.length, 1);
    assert.match(block.content, /Host gh/);
  } finally {
    await h.cleanup();
  }
});
