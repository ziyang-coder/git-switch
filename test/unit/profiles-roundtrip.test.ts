import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createTmpHome, PROFILE_GITHUB_GITEE } from "../helpers/tmp-home.ts";
import {
  ProfilesMissingError,
  loadProfiles,
  parseProfilesText,
  profilesExist,
  saveProfiles,
} from "../../src/core/profiles.ts";
import { ModelError, type Profiles } from "../../src/core/model.ts";
import { gsPaths } from "../../src/core/paths.ts";

/**
 * `profiles.yaml` is the single source of truth and is also the file a user
 * hand-edits. These tests cover the file-level contract:
 *
 *   - a missing file is a distinct, actionable error (not "invalid profile")
 *   - the file is found under the *supplied* home only
 *   - save -> load is lossless for every field the model can hold
 *   - saving twice produces identical bytes, so `gs diff` stays clean
 *
 * Everything runs against a throw-away home from createTmpHome; the developer's
 * real ~/.config/gs is never touched.
 */

const posix = (p: string) => p.replace(/\\/g, "/");

function seed(home: string, text = PROFILE_GITHUB_GITEE): string {
  return text.replace(/__HOME__/g, posix(home));
}

function profileWithEveryField(home: string): Profiles {
  return {
    schemaVersion: 1,
    identities: [
      {
        name: "personal",
        user: { name: "alexchen", email: "alex@personal.example" },
        sshKey: "id_ed25519_github",
        credentialUsername: "alex",
      },
      {
        name: "work",
        user: { name: "Alex Chen", email: "alex@company.example" },
      },
    ],
    sites: [
      {
        host: "github.com",
        port: 443,
        user: "git",
        identity: "personal",
        sshKey: "id_site",
        alias: "gh",
        sshHostName: "ssh.github.com",
        alsoRoutes: ["ghe.example", "github.example"],
      },
      { host: "git.company.example", identity: "work", port: 9092 },
    ],
    rules: [
      {
        dir: `${posix(home)}/code/personal`,
        identity: "personal",
        comment: "it's #1: ok",
      },
      { dir: `${posix(home)}/code/work`, identity: "work" },
    ],
    repositories: [{ path: `${posix(home)}/code/special`, identity: "work" }],
    settings: { backupKeep: 3, allowRoots: [`${posix(home)}/ext`] },
  };
}

/* ------------------------------------------------------------------ */
/* loadProfiles                                                        */
/* ------------------------------------------------------------------ */

test("a missing profile raises ProfilesMissingError naming the file and the fix", async () => {
  const h = await createTmpHome();
  try {
    await assert.rejects(
      () => loadProfiles(h.home),
      (err: unknown) => {
        assert.ok(err instanceof ProfilesMissingError);
        assert.equal(err.file, gsPaths(h.home).profiles);
        assert.match(err.message, /no profile found/);
        assert.match(
          err.message,
          /gs init/,
          "the message tells the user what to do",
        );
        return true;
      },
    );
    assert.equal(await profilesExist(h.home), false);
  } finally {
    await h.cleanup();
  }
});

test("a missing profile is distinguishable from an unreadable one", async () => {
  // ProfilesMissingError must NOT be a ModelError: callers branch on it to print
  // "run gs init" instead of a schema complaint.
  await assertMissingIsNotModelError();
});

async function assertMissingIsNotModelError() {
  const h = await createTmpHome();
  try {
    await assert.rejects(
      () => loadProfiles(h.home),
      (err: unknown) => {
        assert.ok(
          !(err instanceof ModelError),
          "missing file must not be reported as a schema error",
        );
        assert.ok(err instanceof ProfilesMissingError);
        return true;
      },
    );
  } finally {
    await h.cleanup();
  }
}

test("loadProfiles reads the file under the supplied home, never the real one", async () => {
  const h = await createTmpHome();
  try {
    await h.write(".config/gs/profiles.yaml", seed(h.home));
    const profiles = await loadProfiles(h.home);
    assert.deepEqual(
      profiles.identities.map((i) => i.name),
      ["personal", "work"],
    );
    for (const rule of profiles.rules) {
      assert.ok(
        rule.dir.startsWith(posix(h.home)),
        `${rule.dir} is not under the temporary home`,
      );
    }
    // ~/.gitconfig and ~/.ssh must not have been created by reading the profile
    assert.equal(await h.exists(".gitconfig"), false);
    assert.equal(await h.exists(".ssh"), false);
  } finally {
    await h.cleanup();
  }
});

test("a relative rule dir is resolved against the cwd argument, not the process cwd", async () => {
  const h = await createTmpHome();
  try {
    const cwd = path.join(h.home, "projects");
    await h.write(
      ".config/gs/profiles.yaml",
      `schemaVersion: 1
identities:
  p:
    user:
      name: n
      email: n@example.com
rules:
  - dir: repo
    identity: p
`,
    );
    const profiles = await loadProfiles(h.home, cwd);
    const dir = profiles.rules[0]?.dir ?? "";
    assert.ok(dir.startsWith(posix(cwd)), dir);
  } finally {
    await h.cleanup();
  }
});

test('a "~" rule dir is expanded with the supplied home, not the real one', async () => {
  // `parseProfilesText` must thread the home through to `fromYaml`. If it did
  // not, the rule would be stored as the literal string "~/code" — which still
  // looks plausible, so only an explicit assertion catches it.
  const h = await createTmpHome();
  try {
    const profiles = await (async () => {
      await h.write(
        ".config/gs/profiles.yaml",
        `schemaVersion: 1
identities:
  p:
    user:
      name: n
      email: n@example.com
rules:
  - dir: ~/code
    identity: p
`,
      );
      return loadProfiles(h.home);
    })();
    const dir = profiles.rules[0]?.dir ?? "";
    assert.equal(dir, `${posix(h.home)}/code`);
    assert.ok(!dir.includes("~"), `the tilde was not expanded: ${dir}`);
    // and it must not have been expanded against the developer's real home
    assert.ok(dir.startsWith(posix(h.home)), dir);
  } finally {
    await h.cleanup();
  }
});

test("a YAML syntax error is reported as a ModelError about profiles.yaml", async () => {
  const h = await createTmpHome();
  try {
    await h.write(
      ".config/gs/profiles.yaml",
      "schemaVersion: 1\nidentities:\n\tbad: tab\n",
    );
    await assert.rejects(
      () => loadProfiles(h.home),
      (err: unknown) => {
        assert.ok(err instanceof ModelError);
        assert.match(
          err.message,
          /^profiles\.yaml:/,
          "the error names the file the user has to edit",
        );
        assert.match(err.message, /tabs are not allowed/);
        return true;
      },
    );
  } finally {
    await h.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* text encodings and shapes                                           */
/* ------------------------------------------------------------------ */

test("a UTF-8 BOM, CRLF line endings and a leading comment all load", async () => {
  const h = await createTmpHome();
  try {
    const raw = seed(h.home);
    await h.write(
      ".config/gs/profiles.yaml",
      `\uFEFF# edited by hand\r\n${raw.replace(/\n/g, "\r\n")}`,
    );
    const profiles = await loadProfiles(h.home);
    assert.deepEqual(
      profiles.identities.map((i) => i.name),
      ["personal", "work"],
    );
  } finally {
    await h.cleanup();
  }
});

test("an empty or whitespace-only file is rejected as missing schemaVersion", async () => {
  for (const text of ["", "   \n\n", "# just a comment\n", "\uFEFF"]) {
    const h = await createTmpHome();
    try {
      await h.write(".config/gs/profiles.yaml", text);
      await assert.rejects(
        () => loadProfiles(h.home),
        (err: unknown) => {
          assert.ok(
            err instanceof ModelError,
            `expected ModelError for ${JSON.stringify(text)}`,
          );
          assert.match(err.message, /missing schemaVersion/);
          return true;
        },
      );
    } finally {
      await h.cleanup();
    }
  }
});

test("a very long line is accepted rather than truncated", () => {
  // Nothing in the format limits a line; a comment or a deep path can be long
  // and must survive in full.
  const long = "x".repeat(200_000);
  const profiles = parseProfilesText(
    `schemaVersion: 1
identities:
  p:
    user:
      name: p
      email: p@example.com
rules:
  - dir: /tmp/${long}
    identity: p
    comment: ${long}
`,
    "/home/tester",
  );
  assert.equal(profiles.rules[0]?.comment, long);
  assert.ok(
    profiles.rules[0]?.dir.endsWith(long),
    "the path was not truncated",
  );
});

test("a profile with no rules/sites/settings yields the documented defaults", () => {
  const profiles = parseProfilesText(
    `schemaVersion: 1
identities:
  only:
    user:
      name: only
      email: only@example.com
`,
    "/home/tester",
  );
  assert.deepEqual(profiles.sites, []);
  assert.deepEqual(profiles.rules, []);
  assert.deepEqual(profiles.repositories, []);
  assert.deepEqual(profiles.settings, { backupKeep: 20, allowRoots: [] });
});

/* ------------------------------------------------------------------ */
/* save / load round trip                                              */
/* ------------------------------------------------------------------ */

test("save then load preserves every field the model can hold", async () => {
  const h = await createTmpHome();
  try {
    const original = profileWithEveryField(h.home);
    await saveProfiles(h.home, original);
    assert.equal(await profilesExist(h.home), true);

    const reloaded = await loadProfiles(h.home);
    assert.deepEqual(reloaded, original);
  } finally {
    await h.cleanup();
  }
});

test("saving the same profile twice produces identical bytes", async () => {
  // `gs apply` is meant to be idempotent: if the serialiser drifted, every run
  // would report a change that does not exist.
  const h = await createTmpHome();
  try {
    await saveProfiles(h.home, profileWithEveryField(h.home));
    const first = await h.read(".config/gs/profiles.yaml");
    const reloaded = await loadProfiles(h.home);
    await saveProfiles(h.home, reloaded);
    const second = await h.read(".config/gs/profiles.yaml");
    assert.equal(second, first);
  } finally {
    await h.cleanup();
  }
});

test("the saved file is plain YAML with the schema at the top", async () => {
  const h = await createTmpHome();
  try {
    const profiles = await (async () => {
      await h.write(".config/gs/profiles.yaml", seed(h.home));
      return loadProfiles(h.home);
    })();
    await saveProfiles(h.home, profiles);
    const text = await h.read(".config/gs/profiles.yaml");
    assert.match(
      text,
      /^schemaVersion: 1\n/,
      "schemaVersion is the first line",
    );
    assert.ok(text.endsWith("\n"), "the file ends with a newline");
    assert.ok(text.includes("identities:"));
    assert.ok(
      !text.includes("\\"),
      `stored paths use forward slashes:\n${text}`,
    );
    assert.ok(!text.includes("undefined"), "no undefined leaked into the file");
  } finally {
    await h.cleanup();
  }
});

test("a comment with YAML-significant characters survives a save/load cycle", async () => {
  const h = await createTmpHome();
  try {
    const tricky = [
      "it's #1: ok",
      "ends with space ",
      " starts with space",
      "a: b",
      "[looks, like, flow]",
      "- dash",
      "null",
      "true",
      "50% sure",
      "back\\slash",
      'quote " inside',
      "emoji 🚀 中文",
      "---",
    ];
    const base = profileWithEveryField(h.home);
    // One rule per comment, then compare as a directory -> comment mapping: the
    // loader re-sorts rules by length, so rule order is not a round-trip property.
    const profiles: Profiles = {
      ...base,
      rules: tricky.map((comment, i) => ({
        dir: `${posix(h.home)}/code/rule-${String(i).padStart(2, "0")}`,
        identity: "personal",
        comment,
      })),
    };
    await saveProfiles(h.home, profiles);
    const reloaded = await loadProfiles(h.home);
    const actual = Object.fromEntries(
      reloaded.rules.map((r) => [path.posix.basename(r.dir), r.comment]),
    );
    const expected = Object.fromEntries(
      profiles.rules.map((r) => [path.posix.basename(r.dir), r.comment]),
    );
    assert.deepEqual(actual, expected);
  } finally {
    await h.cleanup();
  }
});

test("saveProfiles creates the config directory if it does not exist yet", async () => {
  const h = await createTmpHome();
  try {
    assert.equal(await h.exists(".config"), false);
    await saveProfiles(h.home, profileWithEveryField(h.home));
    assert.equal(await h.exists(".config/gs/profiles.yaml"), true);
  } finally {
    await h.cleanup();
  }
});

test("saveProfiles leaves no temporary file behind", async () => {
  const h = await createTmpHome();
  try {
    await saveProfiles(h.home, profileWithEveryField(h.home));
    await saveProfiles(h.home, profileWithEveryField(h.home));
    const names = await readdir(path.join(h.home, ".config", "gs"));
    assert.deepEqual(
      names.filter((n) => n !== "profiles.yaml"),
      [],
      `stray files: ${names.join(", ")}`,
    );
  } finally {
    await h.cleanup();
  }
});

test("a profile saved by gs passes its own secret guard", async () => {
  // The serialiser must not emit anything that the loader would then refuse: a
  // value the model accepts is written verbatim, so the two stay consistent.
  const h = await createTmpHome();
  try {
    const base = profileWithEveryField(h.home);
    const profiles: Profiles = {
      ...base,
      rules: [
        ...base.rules,
        {
          dir: `${posix(h.home)}/code/notes`,
          identity: "work",
          comment: "secret santa folder",
        },
      ],
    };
    await saveProfiles(h.home, profiles);
    const reloaded = await loadProfiles(h.home);
    const notes = reloaded.rules.find((r) => r.dir.endsWith("/code/notes"));
    assert.equal(notes?.comment, "secret santa folder");
  } finally {
    await h.cleanup();
  }
});
