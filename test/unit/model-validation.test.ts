import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ModelError,
  SCHEMA_VERSION,
  fromYaml,
  keyForSite,
  resolveIdentity,
  sitesFor,
  toYaml,
  type Profiles,
} from "../../src/core/model.ts";
import { parseProfilesText } from "../../src/core/profiles.ts";

/**
 * `model.ts` decides which identity a repository belongs to. A wrong "longest
 * match", a rule that silently overrides a more specific one, or a missing
 * secret check each turn into a commit authored under the wrong email — the
 * exact failure that prompted this project. The tests below pin the resolution
 * ordering, the validation contract, and the sites/keys accessors.
 */

const HOME = "/home/tester";
const CWD = "/work";

const BASE_IDENTITIES: Record<string, unknown> = {
  personal: { user: { name: "alexchen", email: "alex@personal.example" } },
  work: { user: { name: "Alex Chen", email: "alex@company.example" } },
};

/**
 * Build a raw document. `identities` replaces the default pair; `only` keeps
 * just the listed default identities (useful to prove a field belongs to one
 * identity); every other key is merged in at the top level.
 */
function doc(
  extra: Record<string, unknown> = {},
  only?: string[],
): Record<string, unknown> {
  const identities =
    extra.identities !== undefined
      ? (extra.identities as Record<string, unknown>)
      : only
        ? Object.fromEntries(
            Object.entries(BASE_IDENTITIES).filter(([k]) => only.includes(k)),
          )
        : { ...BASE_IDENTITIES };
  return {
    schemaVersion: 1,
    identities,
    ...Object.fromEntries(
      Object.entries(extra).filter(([k]) => k !== "identities"),
    ),
  };
}

function load(
  extra: Record<string, unknown> = {},
  opts: { home?: string; cwd?: string } = {},
): Profiles {
  return fromYaml(doc(extra) as never, {
    home: opts.home ?? HOME,
    cwd: opts.cwd ?? CWD,
  });
}

/** Load a document whose `identities` block is replaced wholesale. */
function loadIdentities(identities: Record<string, unknown>): Profiles {
  return fromYaml(doc({ identities }) as never, { home: HOME, cwd: CWD });
}

function expectModelError(
  fn: () => unknown,
  pattern: RegExp | string,
): ModelError {
  try {
    fn();
  } catch (err) {
    assert.ok(
      err instanceof ModelError,
      `expected a ModelError, got ${String(err)}`,
    );
    if (typeof pattern === "string")
      assert.equal(err.message.includes(pattern), true, err.message);
    else assert.match(err.message, pattern);
    return err;
  }
  assert.fail(`expected a ModelError matching ${pattern}, nothing was thrown`);
}

/* ------------------------------------------------------------------ */
/* schemaVersion gate                                                  */
/* ------------------------------------------------------------------ */

test("only the exact current schema version is accepted", () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(load().schemaVersion, 1);

  expectModelError(
    () => load({ schemaVersion: 2 }),
    /unsupported schemaVersion 2 \(this build supports 1\)/,
  );
  expectModelError(
    () => load({ schemaVersion: 0 }),
    /unsupported schemaVersion 0/,
  );
  expectModelError(() => load({ schemaVersion: "1" }), /expected an integer/);
  expectModelError(() => load({ schemaVersion: 1.5 }), /expected an integer/);
  expectModelError(() => load({ schemaVersion: true }), /expected an integer/);
  // null / missing both mean "the field is absent"
  expectModelError(
    () => load({ schemaVersion: null }),
    /missing schemaVersion/,
  );
  const { schemaVersion: _drop, ...rest } = doc();
  expectModelError(
    () => fromYaml(rest as never, { home: HOME, cwd: CWD }),
    /missing schemaVersion/,
  );
});

/* ------------------------------------------------------------------ */
/* identity validation                                                 */
/* ------------------------------------------------------------------ */

test("at least one identity is required", () => {
  expectModelError(
    () => load({ identities: {} }),
    /at least one identity is required/,
  );
});

test("identity names allow letters, digits, dot, dash and underscore only", () => {
  for (const ok of ["a", "A1", "work-1", "personal.github", "x_y.z-9"]) {
    const profiles = loadIdentities({
      [ok]: { user: { name: "n", email: "n@e.com" } },
    });
    assert.deepEqual(
      profiles.identities.map((i) => i.name),
      [ok],
    );
  }
  for (const bad of [
    "has space",
    "用户",
    "$dollar",
    "slash/name",
    "colon:name",
    "_leading_underscore",
  ]) {
    expectModelError(
      () =>
        loadIdentities({ [bad]: { user: { name: "n", email: "n@e.com" } } }),
      /identity name may contain only letters, digits, dot, dash and underscore/,
    );
  }
});

test("a name that only differs by case is a distinct identity", () => {
  const profiles = loadIdentities({
    Work: { user: { name: "w", email: "w@e.com" } },
    work: { user: { name: "w2", email: "w2@e.com" } },
  });
  assert.deepEqual(
    profiles.identities.map((i) => i.name),
    ["Work", "work"],
  );
});

test("user.name and user.email are both required and must be strings", () => {
  expectModelError(
    () => loadIdentities({ x: { user: { email: "a@e.com" } } }),
    /identities\.x\.user\.name: expected a string/,
  );
  expectModelError(
    () => loadIdentities({ x: { user: { name: "a" } } }),
    /identities\.x\.user\.email: expected a string/,
  );
  expectModelError(
    () => loadIdentities({ x: { user: { name: 5, email: "a@e.com" } } }),
    /expected a string/,
  );
  expectModelError(
    () => loadIdentities({ x: { user: "nope" } }),
    /identities\.x\.user: expected a mapping/,
  );
  expectModelError(
    () => loadIdentities({ x: null }),
    /identities\.x\.user\.name: expected a string/,
  );
});

test("the email check only requires one @ with no spaces", () => {
  // Deliberately loose: the tool must not reject a valid corporate address.
  for (const email of ["a@b.c", "first.last+tag@sub.example.co.uk", "a@b"]) {
    const profiles = loadIdentities({ x: { user: { name: "n", email } } });
    assert.equal(profiles.identities[0]?.user.email, email);
  }
  for (const email of [
    "no-at-sign",
    "a b@example.com",
    "a@b c.com",
    "a@@b.com",
    "@bare.example",
    "a@",
  ]) {
    expectModelError(
      () => loadIdentities({ x: { user: { name: "n", email } } }),
      /not a valid email/,
    );
  }
});

test("sshKey must be a bare file name, never a path", () => {
  for (const sshKey of ["id_ed25519", "id_ed25519.pub", "my-key_1.backup"]) {
    const profiles = loadIdentities({
      x: { user: { name: "n", email: "n@e.com" }, sshKey },
    });
    assert.equal(profiles.identities[0]?.sshKey, sshKey);
  }
  for (const sshKey of [
    "../../etc/passwd",
    "sub/key",
    "key with space",
    "C:/Users/me/key",
    "~/key",
  ]) {
    expectModelError(
      () =>
        loadIdentities({
          x: { user: { name: "n", email: "n@e.com" }, sshKey },
        }),
      /sshKey must be a file name under ~\/\.ssh/,
    );
  }
});

test('a ".." sshKey is rejected: it escapes ~/.ssh when joined', () => {
  // REGRESSION TEST for a real defect. KEY_NAME_RE accepts "." and "..", so
  // `path.join(paths.sshDir, '..')` resolves to the home directory itself and
  // the preflight in plan.ts stats ~ instead of a key file. `sshKey` is
  // documented as "a file name under ~/.ssh"; ".." is not a file name.
  expectModelError(
    () =>
      loadIdentities({
        x: { user: { name: "n", email: "n@e.com" }, sshKey: ".." },
      }),
    /sshKey must be a file name under ~\/\.ssh/,
  );
  expectModelError(
    () =>
      loadIdentities({
        x: { user: { name: "n", email: "n@e.com" }, sshKey: "." },
      }),
    /sshKey must be a file name under ~\/\.ssh/,
  );
});

test("an unknown field is dropped rather than kept", () => {
  // Dropping is intentional: a typo must not become data. Pin it so nobody
  // silently starts persisting half-understood keys.
  const profiles = loadIdentities({
    x: { user: { name: "n", email: "n@e.com" }, favouriteColour: "blue" },
  });
  assert.deepEqual(profiles.identities[0], {
    name: "x",
    user: { name: "n", email: "n@e.com" },
  });
});

/* ------------------------------------------------------------------ */
/* sites                                                               */
/* ------------------------------------------------------------------ */

test("nested sites inherit the identity; top-level sites must name one", () => {
  const profiles = fromYaml(
    {
      schemaVersion: 1,
      identities: {
        p: {
          user: { name: "n", email: "n@e.com" },
          sites: [{ host: "github.com" }],
        },
        work: {
          user: { name: "w", email: "w@e.com" },
          sites: [{ host: "gitee.com", identity: "p" }],
        },
      },
      sites: [{ host: "git.company.example", identity: "work" }],
    },
    { home: HOME, cwd: CWD },
  );
  assert.deepEqual(
    profiles.sites.map((s) => [s.host, s.identity]),
    [
      ["github.com", "p"],
      // a nested site may address a *different* identity
      ["gitee.com", "p"],
      ["git.company.example", "work"],
    ],
  );

  expectModelError(
    () => load({ sites: [{ host: "h.com" }] }),
    /sites\[0\]\.identity: site requires an identity/,
  );
});

test("a site must reference an identity that exists", () => {
  expectModelError(
    () => load({ sites: [{ host: "h.com", identity: "ghost" }] }),
    /unknown identity "ghost"/,
  );
});

test("a site host must be hostname-like", () => {
  const ok = [
    "github.com",
    "ssh.github.com",
    "10.0.0.1",
    "g",
    "xn--fiqs8s.example",
  ];
  for (const host of ok) {
    assert.equal(
      load({ sites: [{ host, identity: "work" }] }).sites[0]?.host,
      host,
    );
  }
  const bad = [
    "github.com.", // trailing dot
    "my_host.com",
    "github.com/x",
    "user@github.com",
    "github.com:22",
    ".github.com",
    "-github.com",
    "",
  ];
  for (const host of bad) {
    expectModelError(
      () => load({ sites: [{ host, identity: "work" }] }),
      /not a valid host/,
    );
  }
});

test("a site port must be an integer inside 1..65535", () => {
  for (const port of [1, 22, 443, 65535]) {
    assert.equal(
      load({ sites: [{ host: "h.com", identity: "work", port }] }).sites[0]
        ?.port,
      port,
    );
  }
  for (const port of [0, -1, 65536]) {
    expectModelError(
      () => load({ sites: [{ host: "h.com", identity: "work", port }] }),
      /port out of range/,
    );
  }
  for (const port of [1.5, "22"]) {
    expectModelError(
      () => load({ sites: [{ host: "h.com", identity: "work", port }] }),
      /expected an integer/,
    );
  }
});

test("a site alias must be a hostname-like token without a port or slash", () => {
  for (const alias of ["gh", "gh-work", "gh.work", "a1"]) {
    assert.equal(
      load({ sites: [{ host: "h.com", identity: "work", alias }] }).sites[0]
        ?.alias,
      alias,
    );
  }
  for (const alias of ["gh:22", "gh/x", "my_alias", "-gh", ""]) {
    expectModelError(
      () => load({ sites: [{ host: "h.com", identity: "work", alias }] }),
      /alias must be a hostname-like token/,
    );
  }
});

test("alsoRoutes must be a list of valid hosts", () => {
  const site = load({
    sites: [
      {
        host: "h.com",
        identity: "work",
        alsoRoutes: ["a.example", "b.example"],
      },
    ],
  }).sites[0];
  assert.deepEqual(site?.alsoRoutes, ["a.example", "b.example"]);
  expectModelError(
    () =>
      load({
        sites: [{ host: "h.com", identity: "work", alsoRoutes: "a.example" }],
      }),
    /expected a list/,
  );
  expectModelError(
    () =>
      load({
        sites: [
          { host: "h.com", identity: "work", alsoRoutes: ["not a host"] },
        ],
      }),
    /alsoRoutes\[0\]: not a valid host/,
  );
});

test("two sites on the same host:port are rejected, different ports are fine", () => {
  expectModelError(
    () =>
      load({
        sites: [
          { host: "github.com", identity: "personal" },
          { host: "github.com", identity: "work" },
        ],
      }),
    /duplicate site github\.com:22/,
  );
  // an explicit port 22 collides with the implicit default
  expectModelError(
    () =>
      load({
        sites: [
          { host: "github.com", identity: "personal" },
          { host: "github.com", identity: "work", port: 22 },
        ],
      }),
    /duplicate site github\.com:22/,
  );
  const separate = load({
    sites: [
      { host: "github.com", identity: "personal" },
      { host: "github.com", identity: "work", port: 443 },
    ],
  });
  assert.equal(separate.sites.length, 2);
  // Hostnames are compared case sensitively here: `GitHub.com` and `github.com`
  // are different keys.
  const cased = load({
    sites: [
      { host: "github.com", identity: "personal" },
      { host: "GitHub.com", identity: "work" },
    ],
  });
  assert.equal(cased.sites.length, 2);
});

/* ------------------------------------------------------------------ */
/* rules: normalisation, conflicts and ordering                        */
/* ------------------------------------------------------------------ */

test("a rule directory is normalised through the path helpers at load time", () => {
  const profiles = load({
    rules: [
      { dir: `${HOME}/code//x/`, identity: "personal" },
      { dir: "~/code/./y", identity: "work" },
      { dir: "rel/z", identity: "work" },
    ],
  });
  const dirs = profiles.rules.map((r) => r.dir).sort();
  assert.ok(dirs.includes(`${HOME}/code/x`), JSON.stringify(dirs));
  assert.ok(dirs.includes(`${HOME}/code/y`), JSON.stringify(dirs));
  const relative = dirs.find((d) => d.endsWith("/rel/z"));
  assert.ok(relative, JSON.stringify(dirs));
  assert.ok(
    !relative.includes("\\"),
    `stored dirs use forward slashes: ${relative}`,
  );
  assert.ok(
    relative.endsWith("/work/rel/z") ||
      relative.endsWith("/cwd/rel/z") === false,
    relative,
  );
});

test("rules are sorted longest-first so the most specific directory wins", () => {
  const profiles = load({
    rules: [
      { dir: `${HOME}/code`, identity: "personal" },
      { dir: `${HOME}/code/work/deep`, identity: "personal" },
      { dir: `${HOME}/code/work`, identity: "work" },
    ],
  });
  assert.deepEqual(
    profiles.rules.map((r) => r.dir),
    [`${HOME}/code/work/deep`, `${HOME}/code/work`, `${HOME}/code`],
  );
});

test("two rules for the same directory are a load error even with the same identity", () => {
  expectModelError(
    () =>
      load({
        rules: [
          { dir: `${HOME}/code/x`, identity: "personal" },
          { dir: `${HOME}/code/x/`, identity: "work" },
        ],
      }),
    /directory rules conflict/,
  );
  // identical normalisation is still a conflict: the file is ambiguous
  expectModelError(
    () =>
      load({
        rules: [
          { dir: `${HOME}/code/x`, identity: "personal" },
          { dir: `${HOME}/code/x`, identity: "personal" },
        ],
      }),
    /mapped twice/,
  );
});

test("a rule must point at a known identity and carry a directory", () => {
  expectModelError(
    () => load({ rules: [{ dir: "/x", identity: "ghost" }] }),
    /unknown identity "ghost"/,
  );
  expectModelError(
    () => load({ rules: [{ identity: "work" }] }),
    /rules\[0\]\.dir: expected a string/,
  );
  expectModelError(
    () => load({ rules: [{ dir: "/x" }] }),
    /rules\[0\]\.identity: expected a string/,
  );
  expectModelError(
    () => load({ rules: ["/x"] }),
    /rules\[0\]: expected a mapping/,
  );
});

test("a rule comment is optional and survives verbatim", () => {
  const profiles = load({
    rules: [
      { dir: `${HOME}/code/x`, identity: "work", comment: "it's #1: ok" },
    ],
  });
  assert.equal(profiles.rules[0]?.comment, "it's #1: ok");
  assert.equal(
    load({ rules: [{ dir: `${HOME}/code/x`, identity: "work" }] }).rules[0]
      ?.comment,
    undefined,
  );
});

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

test("settings default when the whole block is absent", () => {
  assert.deepEqual(load().settings, { backupKeep: 20, allowRoots: [] });
  assert.deepEqual(load({ settings: null }).settings, {
    backupKeep: 20,
    allowRoots: [],
  });
});

test("backupKeep must be an integer of at least 1", () => {
  assert.equal(load({ settings: { backupKeep: 1 } }).settings.backupKeep, 1);
  assert.equal(
    load({ settings: { backupKeep: 1000 } }).settings.backupKeep,
    1000,
  );
  expectModelError(
    () => load({ settings: { backupKeep: 0 } }),
    /backupKeep must be >= 1/,
  );
  expectModelError(
    () => load({ settings: { backupKeep: -1 } }),
    /backupKeep must be >= 1/,
  );
  expectModelError(
    () => load({ settings: { backupKeep: 2.5 } }),
    /expected an integer/,
  );
  expectModelError(
    () => load({ settings: { backupKeep: "5" } }),
    /expected an integer/,
  );
});

test("allowRoots are normalised like rule directories", () => {
  const profiles = load({
    settings: { allowRoots: [`${HOME}/ext/`, "~/other"] },
  });
  assert.deepEqual(profiles.settings.allowRoots, [
    `${HOME}/ext`,
    `${HOME}/other`,
  ]);
  expectModelError(
    () => load({ settings: { allowRoots: `${HOME}/x` } }),
    /allowRoots: expected a list/,
  );
});

/* ------------------------------------------------------------------ */
/* resolveIdentity                                                     */
/* ------------------------------------------------------------------ */

function withRules(
  rules: [string, string][],
  repositories: [string, string][] = [],
): Profiles {
  return load({
    rules: rules.map(([dir, identity]) => ({ dir, identity })),
    repositories: repositories.map(([path, identity]) => ({ path, identity })),
  });
}

test("resolveIdentity picks the longest matching rule regardless of file order", () => {
  const profiles = withRules([
    [`${HOME}/code`, "personal"],
    [`${HOME}/code/work/special`, "work"],
    [`${HOME}/code/work`, "work"],
  ]);
  assert.equal(
    resolveIdentity(profiles, `${HOME}/code/work/special/deep/repo`)?.detail,
    `directory rule ${HOME}/code/work/special`,
  );
  assert.equal(
    resolveIdentity(profiles, `${HOME}/code/work/other/repo`)?.detail,
    `directory rule ${HOME}/code/work`,
  );
  assert.equal(
    resolveIdentity(profiles, `${HOME}/code/personal/repo`)?.detail,
    `directory rule ${HOME}/code`,
  );
});

test("resolveIdentity requires a whole path segment, never a bare string prefix", () => {
  const profiles = withRules([[`${HOME}/code/work`, "work"]]);
  assert.ok(resolveIdentity(profiles, `${HOME}/code/work`));
  assert.ok(resolveIdentity(profiles, `${HOME}/code/work/repo`));
  assert.equal(
    resolveIdentity(profiles, `${HOME}/code/workflows/repo`),
    undefined,
    "workflows is not under work",
  );
  assert.equal(
    resolveIdentity(profiles, `${HOME}/code/work-mirror`),
    undefined,
  );
});

test("a target with a trailing separator or backslashes still matches", () => {
  const profiles = withRules([[`${HOME}/code/work`, "work"]]);
  assert.ok(resolveIdentity(profiles, `${HOME}/code/work/`));
  // resolveIdentity converts the target to posix itself
  assert.ok(resolveIdentity(profiles, `${HOME}/code/work\\repo`));
});

test("matching is case sensitive, mirroring git gitdir: semantics", () => {
  const profiles = withRules([[`${HOME}/code/GitHub`, "work"]]);
  assert.ok(resolveIdentity(profiles, `${HOME}/code/GitHub/repo`));
  assert.equal(
    resolveIdentity(profiles, `${HOME}/code/github/repo`),
    undefined,
  );
});

test("a repository override beats every directory rule, however specific", () => {
  const profiles = withRules(
    [
      [`${HOME}/code`, "personal"],
      [`${HOME}/code/special`, "personal"],
    ],
    [[`${HOME}/code/special/repo`, "work"]],
  );
  const hit = resolveIdentity(profiles, `${HOME}/code/special/repo/src`);
  assert.equal(hit?.identity.name, "work");
  assert.equal(hit?.reason, "repo");
  assert.equal(hit?.detail, `repository override ${HOME}/code/special/repo`);

  // a sibling repository is unaffected
  assert.equal(
    resolveIdentity(profiles, `${HOME}/code/special/other`)?.reason,
    "rule",
  );
});

test("resolveIdentity picks the longest match even when a shorter rule is listed first", () => {
  // This is the *ordering* guarantee of `resolveIdentity` itself, independent of
  // the load-time sort: a profile mutated in memory (the GUI does this) may be in
  // any order. Matching must prefer the longer, more specific directory.
  const base = withRules([[`${HOME}/code`, "personal"]]);
  const unsorted: Profiles = {
    ...base,
    rules: [
      { dir: `${HOME}/code`, identity: "personal" },
      { dir: `${HOME}/code/work/deep`, identity: "work" },
      { dir: `${HOME}/code/work`, identity: "work" },
    ],
  };
  assert.equal(
    resolveIdentity(unsorted, `${HOME}/code/work/deep/x`)?.detail,
    `directory rule ${HOME}/code/work/deep`,
  );

  const shorterFirst: Profiles = {
    ...base,
    rules: [
      { dir: `${HOME}/code`, identity: "personal" },
      { dir: `${HOME}/code/work`, identity: "work" },
    ],
  };
  assert.equal(
    resolveIdentity(shorterFirst, `${HOME}/code/work/x`)?.identity.name,
    "work",
  );
});

test("resolveIdentity returns undefined outside every rule", () => {
  const profiles = withRules([[`${HOME}/code/work`, "work"]]);
  assert.equal(resolveIdentity(profiles, `${HOME}/elsewhere`), undefined);
  assert.equal(resolveIdentity(profiles, HOME), undefined);
});

test('a rule for "/" matches everything, but a more specific rule still wins', () => {
  const profiles = withRules([
    ["/", "personal"],
    [`${HOME}/code/work`, "work"],
  ]);
  assert.equal(resolveIdentity(profiles, "/")?.identity.name, "personal");
  assert.equal(resolveIdentity(profiles, "/opt/x")?.identity.name, "personal");
  assert.equal(
    resolveIdentity(profiles, `${HOME}/code/work/repo`)?.identity.name,
    "work",
  );
});

test("equal-length rules are only distinguishable by their prefix", () => {
  const profiles = withRules([
    [`${HOME}/code/aa`, "personal"],
    [`${HOME}/code/bb`, "work"],
  ]);
  assert.equal(
    resolveIdentity(profiles, `${HOME}/code/aa/x`)?.identity.name,
    "personal",
  );
  assert.equal(
    resolveIdentity(profiles, `${HOME}/code/bb/x`)?.identity.name,
    "work",
  );
});

test("windows drive letters are preserved and matched case-narrowly", () => {
  const profiles = withRules([["D:/CODE/work", "work"]]);
  assert.equal(
    resolveIdentity(profiles, "D:/CODE/work/repo")?.identity.name,
    "work",
  );
  assert.equal(
    resolveIdentity(profiles, "D:\\CODE\\work\\repo")?.identity.name,
    "work",
  );
  assert.equal(
    resolveIdentity(profiles, "d:/CODE/work/repo"),
    undefined,
    "drive letter case matters",
  );
});

test("resolveIdentity tolerates a hand-mutated profile that lost an identity", () => {
  // The GUI and `gs add` edit in memory; a stale reference must degrade to "skip
  // that entry" instead of throwing inside `gs list` or the plan builder.
  // (The loader cannot produce these states — it rejects unknown identities.)
  const base = withRules([[`${HOME}/code`, "personal"]]);

  const ghostRepo: Profiles = {
    ...base,
    repositories: [{ path: `${HOME}/code/r`, identity: "ghost" }],
  };
  assert.equal(
    resolveIdentity(ghostRepo, `${HOME}/code/r`)?.identity.name,
    "personal",
  );

  const ghostRule: Profiles = {
    ...base,
    rules: [
      { dir: `${HOME}/code/x`, identity: "ghost" },
      { dir: `${HOME}/code`, identity: "personal" },
    ],
  };
  assert.equal(
    resolveIdentity(ghostRule, `${HOME}/code/x/repo`)?.identity.name,
    "personal",
  );

  const allGhost: Profiles = {
    ...base,
    rules: [{ dir: `${HOME}/code`, identity: "ghost" }],
  };
  assert.equal(resolveIdentity(allGhost, `${HOME}/code/x`), undefined);
});

/* ------------------------------------------------------------------ */
/* sitesFor / keyForSite                                               */
/* ------------------------------------------------------------------ */

test("sitesFor returns only the sites of one identity", () => {
  const profiles = load({
    identities: {
      p: {
        user: { name: "p", email: "p@e.com" },
        sites: [{ host: "github.com" }],
      },
      w: {
        user: { name: "w", email: "w@e.com" },
        sites: [{ host: "git.company.example" }],
      },
    },
  });
  assert.deepEqual(
    sitesFor(profiles, "p").map((s) => s.host),
    ["github.com"],
  );
  assert.deepEqual(
    sitesFor(profiles, "w").map((s) => s.host),
    ["git.company.example"],
  );
  assert.deepEqual(sitesFor(profiles, "nope"), []);
});

test("keyForSite prefers the site key, then the identity key, then nothing", () => {
  const profiles = fromYaml(
    {
      schemaVersion: 1,
      identities: {
        withIdKey: {
          user: { name: "a", email: "a@e.com" },
          sshKey: "id_identity",
        },
        bare: { user: { name: "b", email: "b@e.com" } },
      },
    },
    { home: HOME, cwd: CWD },
  );
  assert.equal(
    keyForSite(profiles, { host: "h", identity: "withIdKey" }),
    "id_identity",
  );
  assert.equal(
    keyForSite(profiles, {
      host: "h",
      identity: "withIdKey",
      sshKey: "id_site",
    }),
    "id_site",
  );
  assert.equal(
    keyForSite(profiles, { host: "h", identity: "bare" }),
    undefined,
  );
  assert.equal(
    keyForSite(profiles, { host: "h", identity: "ghost", sshKey: "id_site" }),
    "id_site",
  );
});

/* ------------------------------------------------------------------ */
/* toYaml round trip through the loader                                */
/* ------------------------------------------------------------------ */

test("toYaml/fromYaml round-trips a profile with every optional field", () => {
  const profiles = fromYaml(
    {
      schemaVersion: 1,
      identities: {
        p: {
          user: { name: "a", email: "a@e.com" },
          sshKey: "id_p",
          credentialUsername: "alex",
          sites: [
            {
              host: "github.com",
              port: 443,
              user: "git",
              sshKey: "id_site",
              alias: "gh",
              sshHostName: "ssh.github.com",
              alsoRoutes: ["ghe.example"],
            },
            { host: "gitee.com" },
          ],
        },
        w: { user: { name: "b", email: "b@e.com" } },
      },
      sites: [{ host: "top.example", identity: "w", port: 22 }],
      rules: [
        { dir: `${HOME}/a`, identity: "p", comment: "personal code" },
        { dir: `${HOME}/b`, identity: "w" },
      ],
      repositories: [{ path: `${HOME}/a/override`, identity: "w" }],
      settings: { backupKeep: 3, allowRoots: [`${HOME}/ext`] },
    },
    { home: HOME, cwd: CWD },
  );
  const again = fromYaml(toYaml(profiles), { home: HOME, cwd: CWD });
  assert.deepEqual(again, profiles);
});

test("toYaml groups sites under their identity and omits empty sections", () => {
  const profiles = load();
  const yaml = toYaml(profiles);
  assert.deepEqual(Object.keys(yaml), [
    "schemaVersion",
    "identities",
    "rules",
    "settings",
  ]);
  assert.equal(
    (yaml.identities as Record<string, Record<string, unknown>>).personal
      ?.sites,
    undefined,
  );
  // an empty repository list is left out so the file stays readable
  assert.equal(yaml.repositories, undefined);
});

test("a malformed profile never escapes as a raw TypeError", () => {
  // Whatever shape the YAML has, the user must see a ModelError with a path —
  // `gs` prints ModelError messages as diagnostics but a TypeError stacks out.
  const shapes: unknown[] = [
    [],
    "text",
    5,
    { identities: "x" },
    { identities: { p: 1 } },
    { rules: 1 },
  ];
  for (const shape of shapes) {
    assert.throws(
      () => fromYaml(shape as never, { home: HOME, cwd: CWD }),
      (err: unknown) => err instanceof ModelError,
      `shape ${JSON.stringify(shape)} must raise a ModelError`,
    );
  }
});

test("a null document throws a raw TypeError instead of a ModelError", () => {
  // Known asymmetry: YAML cannot produce `null` as the top-level value (the
  // parser rejects it before `fromYaml` runs), so this is only reachable from an
  // in-process caller. Pinned as current behaviour, not as desirable behaviour.
  assert.throws(
    () => fromYaml(null as never, { home: HOME, cwd: CWD }),
    TypeError,
  );
});

test("a profile with a secret is refused before any other validation error is reported", () => {
  // Secrets are checked first so a pasted token is named even when another field
  // is also wrong; otherwise the token could survive one "fix and retry" cycle.
  const text = `schemaVersion: 99
identities:
  a:
    user:
      name: a
      email: not-an-email
    github_token: ghp_${"a".repeat(36)}
`;
  assert.throws(
    () => parseProfilesText(text, HOME),
    /must not contain secrets/,
  );
});
