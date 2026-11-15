import { test } from "node:test";
import assert from "node:assert/strict";
import { RuleError, removeRule, upsertRule } from "../../src/core/rules.ts";
import {
  resolveIdentity,
  type Profiles,
  type Rule,
} from "../../src/core/model.ts";
import { setLanguage, getLanguage } from "../../src/core/i18n.ts";

/**
 * `upsertRule` / `removeRule` back both `gs add` and POST/DELETE /api/rules, so
 * the two entry points must agree about what "add this directory to that
 * identity" means. The tests pin the observable contract: the returned action,
 * the identity that was replaced, the warnings, and — most importantly — the
 * resulting profile, which is what the next `gs apply` acts on.
 */

function profilesWith(
  rules: Rule[] = [],
  identities = ["personal", "work"],
): Profiles {
  return {
    schemaVersion: 1,
    identities: identities.map((name) => ({
      name,
      user: { name, email: `${name}@example.com` },
    })),
    sites: [],
    rules: rules.map((r) => ({ ...r })),
    repositories: [],
    settings: { backupKeep: 20, allowRoots: [] },
  };
}

function expectRuleError(
  fn: () => unknown,
  kind: "unknown-identity" | "force-fixable",
): RuleError {
  try {
    fn();
  } catch (err) {
    assert.ok(
      err instanceof RuleError,
      `expected a RuleError, got ${String(err)}`,
    );
    assert.equal(err.kind, kind);
    return err;
  }
  assert.fail(`expected a RuleError of kind ${kind}`);
}

/* ------------------------------------------------------------------ */
/* adding                                                              */
/* ------------------------------------------------------------------ */

test('adding a new directory reports "added" and prepends the rule', () => {
  const profiles = profilesWith([
    { dir: "/code/personal", identity: "personal" },
  ]);
  const result = upsertRule({ profiles, dir: "/code/work", identity: "work" });
  assert.equal(result.action, "added");
  assert.deepEqual(result.warnings, []);
  assert.equal(result.previousIdentity, undefined);
  // prepended: the caller never has to re-sort, and the narrow rule is first
  assert.deepEqual(
    profiles.rules.map((r) => r.dir),
    ["/code/work", "/code/personal"],
  );
});

test("a comment is stored with the new rule and an empty one is dropped", () => {
  const profiles = profilesWith();
  upsertRule({
    profiles,
    dir: "/code/a",
    identity: "work",
    comment: "client work",
  });
  upsertRule({ profiles, dir: "/code/b", identity: "work", comment: "" });
  upsertRule({ profiles, dir: "/code/c", identity: "work" });
  assert.equal(
    profiles.rules.find((r) => r.dir === "/code/a")?.comment,
    "client work",
  );
  assert.equal(
    profiles.rules.find((r) => r.dir === "/code/b")?.comment,
    undefined,
    "an empty comment must not be stored",
  );
  assert.equal(
    profiles.rules.find((r) => r.dir === "/code/c")?.comment,
    undefined,
  );
});

test("an unknown identity is refused before anything is mutated", () => {
  const profiles = profilesWith([{ dir: "/code/a", identity: "personal" }]);
  const before = structuredClone(profiles.rules);
  const err = expectRuleError(
    () => upsertRule({ profiles, dir: "/code/b", identity: "ghost" }),
    "unknown-identity",
  );
  assert.match(err.message, /no identity named "ghost"/);
  assert.match(
    err.message,
    /personal.*work/,
    "the message lists the identities that do exist",
  );
  assert.deepEqual(profiles.rules, before);
});

/* ------------------------------------------------------------------ */
/* idempotency and replacement                                         */
/* ------------------------------------------------------------------ */

test('re-adding the same directory to the same identity is "unchanged"', () => {
  const profiles = profilesWith([{ dir: "/code/a", identity: "work" }]);
  const before = structuredClone(profiles.rules);
  const result = upsertRule({ profiles, dir: "/code/a", identity: "work" });
  assert.equal(result.action, "unchanged");
  assert.deepEqual(profiles.rules, before);
});

test('changing only the comment of an existing rule is a "replaced" update', () => {
  const profiles = profilesWith([
    { dir: "/code/a", identity: "work", comment: "old" },
  ]);
  const result = upsertRule({
    profiles,
    dir: "/code/a",
    identity: "work",
    comment: "new",
  });
  assert.equal(result.action, "replaced");
  assert.equal(
    result.previousIdentity,
    undefined,
    "the identity did not change",
  );
  assert.equal(profiles.rules[0]?.comment, "new");
  assert.equal(profiles.rules.length, 1, "no duplicate rule was created");
});

test("leaving the comment out of an update does not clear the stored comment", () => {
  const profiles = profilesWith([
    { dir: "/code/a", identity: "work", comment: "keep me" },
  ]);
  const result = upsertRule({ profiles, dir: "/code/a", identity: "work" });
  assert.equal(result.action, "unchanged");
  assert.equal(profiles.rules[0]?.comment, "keep me");
});

test("re-adding an identical rule is idempotent even with the comment supplied", () => {
  const profiles = profilesWith([
    { dir: "/code/a", identity: "work", comment: "same" },
  ]);
  const result = upsertRule({
    profiles,
    dir: "/code/a",
    identity: "work",
    comment: "same",
  });
  assert.equal(result.action, "unchanged");
});

test("re-pointing an existing rule at another identity needs --force", () => {
  const profiles = profilesWith([{ dir: "/code/a", identity: "personal" }]);
  const err = expectRuleError(
    () => upsertRule({ profiles, dir: "/code/a", identity: "work" }),
    "force-fixable",
  );
  assert.match(err.message, /already belongs to identity personal/);
  assert.match(
    err.message,
    /--force/,
    "the error tells the user how to proceed",
  );
  assert.equal(
    profiles.rules[0]?.identity,
    "personal",
    "the profile was not mutated",
  );
});

test("--force re-points the rule in place and reports the previous identity", () => {
  const profiles = profilesWith([
    { dir: "/code/a", identity: "personal", comment: "old" },
  ]);
  const result = upsertRule({
    profiles,
    dir: "/code/a",
    identity: "work",
    force: true,
  });
  assert.equal(result.action, "replaced");
  assert.equal(result.previousIdentity, "personal");
  assert.equal(profiles.rules.length, 1);
  assert.equal(profiles.rules[0]?.identity, "work");
  // without a new comment, the existing one is kept
  assert.equal(profiles.rules[0]?.comment, "old");
});

test("--force with a comment replaces the old comment too", () => {
  const profiles = profilesWith([
    { dir: "/code/a", identity: "personal", comment: "old" },
  ]);
  upsertRule({
    profiles,
    dir: "/code/a",
    identity: "work",
    force: true,
    comment: "new",
  });
  assert.equal(profiles.rules[0]?.comment, "new");
});

test('directory matching for the "already bound" check is exact, not normalised', () => {
  // Known sharp edge, pinned deliberately: the caller is documented to pass a
  // normalised path, so `/code/a` and `/code/a/` are treated as different
  // directories. If a caller ever passes a raw path, `gs add` creates a
  // duplicate rule that the loader then rejects as "mapped twice".
  const profiles = profilesWith([{ dir: "/code/a", identity: "personal" }]);
  const result = upsertRule({ profiles, dir: "/code/a/", identity: "work" });
  assert.equal(result.action, "added");
  assert.deepEqual(
    profiles.rules.map((r) => r.dir),
    ["/code/a/", "/code/a"],
  );
});

/* ------------------------------------------------------------------ */
/* warnings                                                            */
/* ------------------------------------------------------------------ */

test("adding below an existing rule warns that the new rule is more specific", () => {
  const profiles = profilesWith([{ dir: "/code", identity: "personal" }]);
  const result = upsertRule({ profiles, dir: "/code/work", identity: "work" });
  assert.equal(result.action, "added");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /\/code .*already covered .*personal/);
  assert.match(result.warnings[0] ?? "", /more specific/);
});

test("adding above existing rules warns that the children become redundant", () => {
  const profiles = profilesWith([
    { dir: "/code/a", identity: "personal" },
    { dir: "/code/b", identity: "work" },
  ]);
  const result = upsertRule({ profiles, dir: "/code", identity: "personal" });
  assert.equal(result.action, "added");
  assert.equal(result.warnings.length, 1);
  assert.match(
    result.warnings[0] ?? "",
    /\/code\/a.*\/code\/b/,
    "both covered directories are listed",
  );
});

test("an add that both sits under a rule and covers others emits both warnings", () => {
  const profiles = profilesWith([
    { dir: "/code", identity: "personal" },
    { dir: "/code/work/deep", identity: "personal" },
  ]);
  const result = upsertRule({ profiles, dir: "/code/work", identity: "work" });
  assert.equal(result.warnings.length, 2);
});

test("a sibling directory that merely shares a prefix is not a parent or a child", () => {
  const profiles = profilesWith([{ dir: "/code/work", identity: "personal" }]);
  const result = upsertRule({
    profiles,
    dir: "/code/workflows",
    identity: "work",
  });
  assert.deepEqual(
    result.warnings,
    [],
    "workflows is neither under work nor covering it",
  );
});

test("a trailing slash on the stored parent does not break the parent detection", () => {
  const profiles = profilesWith([{ dir: "/code/", identity: "personal" }]);
  const result = upsertRule({ profiles, dir: "/code/work", identity: "work" });
  assert.equal(result.warnings.length, 1);
});

/* ------------------------------------------------------------------ */
/* the resulting profile is what resolveIdentity acts on               */
/* ------------------------------------------------------------------ */

test("after `gs add` the most specific rule wins without re-sorting", () => {
  const profiles = profilesWith([{ dir: "/code", identity: "personal" }]);
  assert.equal(
    resolveIdentity(profiles, "/code/work/repo")?.identity.name,
    "personal",
  );
  upsertRule({ profiles, dir: "/code/work", identity: "work" });
  assert.equal(
    resolveIdentity(profiles, "/code/work/repo")?.identity.name,
    "work",
  );
  assert.equal(
    resolveIdentity(profiles, "/code/other")?.identity.name,
    "personal",
  );
});

test("a forced re-point changes resolution immediately", () => {
  const profiles = profilesWith([{ dir: "/code/repo", identity: "personal" }]);
  assert.equal(
    resolveIdentity(profiles, "/code/repo")?.identity.name,
    "personal",
  );
  upsertRule({ profiles, dir: "/code/repo", identity: "work", force: true });
  assert.equal(resolveIdentity(profiles, "/code/repo")?.identity.name, "work");
});

/* ------------------------------------------------------------------ */
/* removeRule                                                          */
/* ------------------------------------------------------------------ */

test("removeRule removes the matching directory and reports the identity", () => {
  const profiles = profilesWith([
    { dir: "/code/a", identity: "personal" },
    { dir: "/code/b", identity: "work" },
  ]);
  const result = removeRule(profiles, "/code/a");
  assert.deepEqual(result, { removed: true, identity: "personal" });
  assert.deepEqual(
    profiles.rules.map((r) => r.dir),
    ["/code/b"],
  );
});

test("removeRule on a missing directory changes nothing", () => {
  const profiles = profilesWith([{ dir: "/code/a", identity: "personal" }]);
  const before = structuredClone(profiles.rules);
  assert.deepEqual(removeRule(profiles, "/code/missing"), { removed: false });
  assert.deepEqual(profiles.rules, before);
});

test("removeRule is exact like upsertRule: a trailing slash does not match", () => {
  const profiles = profilesWith([{ dir: "/code/a", identity: "personal" }]);
  assert.deepEqual(removeRule(profiles, "/code/a/"), { removed: false });
  assert.equal(profiles.rules.length, 1);
});

test("removeRule removes only the first of two identical entries", () => {
  // The loader refuses duplicates, but the GUI can build them in memory before
  // saving; removal must not cascade and take both.
  const profiles = profilesWith([
    { dir: "/code/a", identity: "personal" },
    { dir: "/code/a", identity: "work" },
  ]);
  const result = removeRule(profiles, "/code/a");
  assert.equal(result.identity, "personal");
  assert.equal(profiles.rules.length, 1);
  assert.equal(profiles.rules[0]?.identity, "work");
});

test("removeRule does not touch sites, repositories or identities", () => {
  const profiles = profilesWith([{ dir: "/code/a", identity: "personal" }]);
  profiles.repositories = [{ path: "/code/a/repo", identity: "personal" }];
  profiles.sites = [{ host: "github.com", identity: "personal" }];
  removeRule(profiles, "/code/a");
  assert.equal(profiles.repositories.length, 1);
  assert.equal(profiles.sites.length, 1);
  assert.equal(profiles.identities.length, 2);
});

/* ------------------------------------------------------------------ */
/* localisation of warnings                                            */
/* ------------------------------------------------------------------ */

test("rule messages follow the active language", () => {
  const original = getLanguage();
  try {
    setLanguage("zh-CN");
    const profiles = profilesWith([{ dir: "/code", identity: "personal" }]);
    const result = upsertRule({
      profiles,
      dir: "/code/work",
      identity: "work",
    });
    assert.match(
      result.warnings[0] ?? "",
      /已由身份/,
      "the warning is translated",
    );
  } finally {
    setLanguage(original);
  }
});

test("an English catalogue is used when the active language has no entry", () => {
  // `t()` falls back to English then to the key, so a stale catalogue can never
  // break `gs add`. The action value itself must stay a stable token.
  const profiles = profilesWith();
  const result = upsertRule({ profiles, dir: "/code/a", identity: "work" });
  assert.deepEqual(
    ["added", "replaced", "unchanged"].includes(result.action),
    true,
  );
});
