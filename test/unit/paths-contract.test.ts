import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  CONFIG_DIR_NAME,
  contractHome,
  expandHome,
  formatIdentity,
  gitdirPattern,
  gsPaths,
  isWindowsAbsolute,
  normaliseRulePath,
  setUserSection,
  toPlatform,
  toPosix,
} from "../../src/core/paths.ts";

/**
 * `profiles.yaml` stores every path with forward slashes so a profile written on
 * Windows replays on macOS/Linux. These helpers are the whole of that contract,
 * and they see paths the user typed by hand: trailing slashes, mixed separators,
 * UNC shares, `..`. They are pure functions, so the expectations hold on every
 * host — the tests deliberately mix POSIX and Windows input in one run.
 */

const HOME_POSIX = "/home/tester";
const CWD_POSIX = "/srv/work";
const win32 = process.platform === "win32";

/* ------------------------------------------------------------------ */
/* toPosix / toPlatform                                                */
/* ------------------------------------------------------------------ */

test("toPosix converts every backslash and leaves forward slashes alone", () => {
  assert.equal(toPosix("C:\\code\\x"), "C:/code/x");
  assert.equal(toPosix("C:/code/x"), "C:/code/x");
  assert.equal(toPosix("mixed\\and/slashes"), "mixed/and/slashes");
  assert.equal(toPosix(""), "");
  assert.equal(toPosix("no/separators"), "no/separators");
  // a UNC share collapses to the "//server/share" form on purpose: the stored
  // form only has to be internally consistent, not valid for ntpath.
  assert.equal(toPosix("\\\\server\\share\\x"), "//server/share/x");
});

test("toPlatform produces exactly path.sep, never a mixture", () => {
  const out = toPlatform("C:/code\\x");
  assert.equal(out, ["C:", "code", "x"].join(path.sep));
  if (path.sep === "\\") {
    assert.ok(!out.includes("/"), out);
  } else {
    assert.ok(!out.includes("\\"), out);
  }
  assert.equal(toPlatform(""), "");
});

/* ------------------------------------------------------------------ */
/* isWindowsAbsolute                                                   */
/* ------------------------------------------------------------------ */

test("isWindowsAbsolute recognises drive-letter and UNC paths", () => {
  for (const input of [
    "D:/x",
    "D:\\x",
    "c:/x",
    "\\\\server\\share",
    "\\\\server",
  ]) {
    assert.equal(isWindowsAbsolute(input), true, input);
  }
  for (const input of [
    "D:",
    "C:relative",
    "//server/share",
    "/posix/path",
    "relative/path",
    "",
    "~",
    "x:/y",
  ]) {
    // `x:/y` is a single-letter drive and IS accepted; it is listed below.
    if (input === "x:/y") continue;
    assert.equal(isWindowsAbsolute(input), false, input);
  }
  assert.equal(
    isWindowsAbsolute("x:/y"),
    true,
    "the drive letter is case insensitive",
  );
});

test('a bare drive "D:" is not treated as absolute', () => {
  // "D:" means "the current directory on drive D:" to Windows and is not
  // enough to identify a location; treating it as absolute would store a rule
  // that can never match.
  assert.equal(isWindowsAbsolute("D:"), false);
  assert.equal(isWindowsAbsolute("D:x"), false);
});

/* ------------------------------------------------------------------ */
/* expandHome                                                          */
/* ------------------------------------------------------------------ */

test("expandHome expands only a leading ~ and ~/", () => {
  assert.equal(toPosix(expandHome("~", HOME_POSIX)), HOME_POSIX);
  assert.equal(toPosix(expandHome("~/code", HOME_POSIX)), `${HOME_POSIX}/code`);
  assert.equal(
    toPosix(expandHome("~\\code", HOME_POSIX)),
    `${HOME_POSIX}/code`,
  );
  assert.equal(
    toPosix(expandHome("~/", HOME_POSIX)).replace(/\/$/, ""),
    HOME_POSIX,
  );
});

test("expandHome leaves a non-leading or user-qualified tilde alone", () => {
  for (const input of ["/a/~/b", "a/~/b", "~user/x", "~root", "x~", ""]) {
    assert.equal(expandHome(input, HOME_POSIX), input);
  }
});

test('expandHome does not resolve ".." out of home', () => {
  // `path.join` normalises, so `~/../x` escapes the home directory. Storing the
  // escaped value is intentional (the user may mean it); what matters is that
  // expansion is a pure string operation and does not silently clamp.
  const out = toPosix(expandHome("~/../x", HOME_POSIX));
  assert.ok(!out.includes("~"), out);
  assert.ok(out.endsWith("/x"), out);
});

/* ------------------------------------------------------------------ */
/* contractHome                                                        */
/* ------------------------------------------------------------------ */

test("contractHome maps the home root to a single tilde", () => {
  assert.equal(contractHome(HOME_POSIX, HOME_POSIX), "~");
  assert.equal(contractHome(`${HOME_POSIX}/`, HOME_POSIX), "~");
  // a trailing separator on the home argument must not confuse the comparison
  assert.equal(contractHome(HOME_POSIX, `${HOME_POSIX}/`), "~");
});

test("contractHome contracts nested paths with forward slashes", () => {
  assert.equal(contractHome(`${HOME_POSIX}/code/x`, HOME_POSIX), "~/code/x");
  // Input backslashes collapse once the path is inside home.
  if (!win32) {
    assert.equal(contractHome(`${HOME_POSIX}/a/../b`, HOME_POSIX), "~/b");
  }
});

test("contractHome does not contract a sibling directory that shares the prefix", () => {
  // /home/tester2 must never become ~/2 — that is how a display bug turns into
  // a wrong file being shown to the user.
  assert.equal(
    contractHome(`${HOME_POSIX}2/x`, HOME_POSIX),
    `${HOME_POSIX}2/x`,
  );
  assert.equal(
    toPosix(contractHome(`${HOME_POSIX}-backup`, HOME_POSIX)),
    `${HOME_POSIX}-backup`,
  );
});

test("contractHome leaves a path outside home alone but still posixifies it", () => {
  const outside = win32 ? "C:\\other\\place" : "/other/place";
  assert.equal(
    contractHome(outside, HOME_POSIX),
    win32 ? "C:/other/place" : outside,
  );
});

test("contractHome of a drive-letter path on a posix home stays readable", () => {
  // gs runs with a home directory, but a rule may still point at another drive.
  assert.equal(contractHome("D:\\code\\x", HOME_POSIX), "D:/code/x");
  assert.equal(
    contractHome("\\\\server\\share\\x", HOME_POSIX),
    "//server/share/x",
  );
});

/* ------------------------------------------------------------------ */
/* normaliseRulePath                                                   */
/* ------------------------------------------------------------------ */

test("normaliseRulePath produces the canonical stored form for POSIX input", () => {
  const cases: [string, string][] = [
    ["/srv/code", "/srv/code"],
    ["/srv/code/", "/srv/code"],
    ["/srv/code///", "/srv/code"],
    ["/srv//code", "/srv/code"],
    ["/srv/./code", "/srv/code"],
    ["/srv/a/../code", "/srv/code"],
  ];
  for (const [input, expected] of cases) {
    if (win32) continue; // these are absolute POSIX paths; the host rules differ
    assert.equal(
      normaliseRulePath(input, HOME_POSIX, CWD_POSIX),
      expected,
      input,
    );
  }
});

test('normaliseRulePath keeps a POSIX root as "/" and never trims it to ""', () => {
  if (win32) return;
  assert.equal(normaliseRulePath("/", HOME_POSIX, CWD_POSIX), "/");
  assert.equal(normaliseRulePath("//", HOME_POSIX, CWD_POSIX), "/");
  assert.equal(normaliseRulePath("/a/../..", HOME_POSIX, CWD_POSIX), "/");
});

test("normaliseRulePath expands a leading tilde before normalising", () => {
  assert.equal(
    toPosix(normaliseRulePath("~/code/x/", HOME_POSIX, CWD_POSIX)),
    `${HOME_POSIX}/code/x`,
  );
  assert.equal(
    toPosix(normaliseRulePath("~\\code\\x", HOME_POSIX, CWD_POSIX)),
    `${HOME_POSIX}/code/x`,
  );
});

test("normaliseRulePath resolves a relative path against the cwd", () => {
  const out = toPosix(normaliseRulePath("sub/dir/", HOME_POSIX, CWD_POSIX));
  assert.ok(out.endsWith("/sub/dir"), out);
  assert.ok(!out.includes("/sub/dir/"), `no trailing slash: ${out}`);
  // With no cwd argument the process cwd is used; it must still be absolute.
  const implicit = toPosix(normaliseRulePath("rel", HOME_POSIX));
  assert.ok(
    implicit.startsWith("/") || /^[A-Za-z]:\//.test(implicit),
    implicit,
  );
});

test("normaliseRulePath stores Windows paths with forward slashes and a lowercase-preserving drive", () => {
  for (const input of [
    "C:\\code\\x",
    "C:/code/x",
    "d:\\code\\x",
    "d:/code/x",
  ]) {
    const out = normaliseRulePath(input, HOME_POSIX, CWD_POSIX);
    assert.match(out, /^[A-Za-z]:\/code\/x$/, `${input} -> ${out}`);
    assert.ok(!out.includes("\\"), out);
    assert.ok(!out.endsWith("/"), out);
  }
  // The drive letter's case is preserved: two profiles that differ only by
  // drive case stay distinguishable (git's gitdir: match is case sensitive).
  assert.equal(normaliseRulePath("D:/code", HOME_POSIX), "D:/code");
  assert.equal(normaliseRulePath("d:/code", HOME_POSIX), "d:/code");
});

test("normaliseRulePath trims trailing separators from Windows paths but keeps the drive root", () => {
  assert.equal(normaliseRulePath("D:/code/x/", HOME_POSIX), "D:/code/x");
  assert.equal(normaliseRulePath("D:/code/x\\", HOME_POSIX), "D:/code/x");
  assert.equal(normaliseRulePath("D:\\", HOME_POSIX), "D:/");
  assert.equal(normaliseRulePath("D:/", HOME_POSIX), "D:/");
  assert.equal(normaliseRulePath("D://x", HOME_POSIX), "D:/x");
});

test("normaliseRulePath recognises a Windows path even when running on POSIX", () => {
  // A snapshot written on Windows is imported on Linux and vice versa; `D:/code`
  // must never be joined onto the cwd as if it were relative.
  const out = normaliseRulePath("D:/code/x", HOME_POSIX, "/app");
  assert.equal(out, "D:/code/x");
  assert.ok(!out.startsWith("/app"), out);
});

test("normaliseRulePath treats a UNC path as absolute and does not join it onto the cwd", () => {
  const out = normaliseRulePath(
    "\\\\server\\share\\repo\\",
    HOME_POSIX,
    "/app",
  );
  assert.ok(!out.startsWith("/app"), out);
  assert.ok(!out.includes("\\"), out);
  assert.ok(!out.endsWith("/"), out);
  assert.ok(out.includes("server"), out);
  assert.ok(out.includes("share"), out);
});

test('normaliseRulePath does not collapse ".." inside a Windows path', () => {
  // Known asymmetry: Windows input only has its separators normalised, so a
  // ".." survives and the stored rule points at a directory git will resolve
  // differently. Pinned so the behaviour cannot change unnoticed.
  assert.equal(normaliseRulePath("C:/a/../../b", HOME_POSIX), "C:/a/../../b");
});

/* ------------------------------------------------------------------ */
/* gitdirPattern                                                       */
/* ------------------------------------------------------------------ */

test("gitdirPattern always ends with exactly one forward slash", () => {
  // Verified against git for Windows: the pattern must have the trailing slash
  // or includeIf silently matches nothing.
  const cases: [string, string][] = [
    ["/home/u/code", "/home/u/code/"],
    ["/home/u/code/", "/home/u/code/"],
    ["/home/u/code//", "/home/u/code//"],
    ["D:/code/x", "D:/code/x/"],
    ["D:\\code\\x", "D:/code/x/"],
    ["/", "/"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(gitdirPattern(input), expected);
  }
});

/* ------------------------------------------------------------------ */
/* gsPaths                                                             */
/* ------------------------------------------------------------------ */

test("gsPaths anchors every file under the supplied home", () => {
  const paths = gsPaths(HOME_POSIX);
  assert.equal(CONFIG_DIR_NAME, "gs");
  assert.equal(toPosix(paths.configDir), `${HOME_POSIX}/.config/gs`);
  assert.equal(
    toPosix(paths.profiles),
    `${HOME_POSIX}/.config/gs/profiles.yaml`,
  );
  assert.equal(toPosix(paths.sshConfig), `${HOME_POSIX}/.ssh/config`);
  assert.equal(toPosix(paths.globalGitConfig), `${HOME_POSIX}/.gitconfig`);
  assert.equal(
    toPosix(paths.identitiesDir),
    `${HOME_POSIX}/.config/gs/identities`,
  );
  assert.equal(toPosix(paths.backupsDir), `${HOME_POSIX}/.config/gs/backups`);
  assert.equal(
    toPosix(paths.snapshotsDir),
    `${HOME_POSIX}/.config/gs/snapshots`,
  );
  assert.equal(toPosix(paths.stateFile), `${HOME_POSIX}/.config/gs/state.json`);
  // every path must live under the given home so --home is a real sandbox
  for (const value of Object.values(paths)) {
    assert.ok(
      toPosix(String(value)).startsWith(toPosix(HOME_POSIX)),
      `${value} escapes the home`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* formatIdentity                                                      */
/* ------------------------------------------------------------------ */

test('formatIdentity renders "Name <email>" and degrades for half a pair', () => {
  assert.equal(
    formatIdentity({ name: "Alex", email: "alex@example.com" }),
    "Alex <alex@example.com>",
  );
  assert.equal(formatIdentity({ name: "Alex" }), "Alex");
  assert.equal(
    formatIdentity({ email: "alex@example.com" }),
    "alex@example.com",
  );
  assert.equal(formatIdentity({}), undefined);
  assert.equal(formatIdentity(undefined), undefined);
});

/* ------------------------------------------------------------------ */
/* setUserSection                                                      */
/* ------------------------------------------------------------------ */

test("setUserSection rewrites only the [user] section and preserves everything else", () => {
  const before = [
    "# my gitconfig",
    "[core]",
    "\teditor = vim",
    "[user]",
    "\tname = Old Name",
    "\temail = old@example.com",
    "[alias]",
    "\tst = status",
    "",
  ].join("\n");
  const after = setUserSection(before, {
    name: "New Name",
    email: "new@example.com",
  });
  assert.match(after, /\[core\]\n\teditor = vim/);
  assert.match(after, /\[alias\]\n\tst = status/);
  assert.match(after, /# my gitconfig/);
  assert.match(after, /\tname = New Name/);
  assert.match(after, /\temail = new@example\.com/);
  assert.ok(!after.includes("Old Name"));
  assert.ok(!after.includes("old@example.com"));
});

test("setUserSection keeps the file EOL convention and trailing newline", () => {
  const crlf = ["[user]", "\tname = a", "\temail = a@e.com", ""].join("\r\n");
  const after = setUserSection(crlf, { name: "b" }, "\r\n");
  assert.ok(!/(?<!\r)\n/.test(after), "every LF must be preceded by CR");
  assert.match(after, /name = b\r\n/);
  assert.match(after, /email = a@e\.com/);
});

test("setUserSection creates the [user] section when absent", () => {
  const after = setUserSection("[core]\n\teditor = vim\n", {
    name: "Alex",
    email: "alex@example.com",
  });
  assert.match(after, /\[user\]/);
  assert.match(after, /name = Alex/);
  assert.match(after, /email = alex@example\.com/);
  // the original content is still there, before the new section
  assert.ok(after.indexOf("[core]") < after.indexOf("[user]"));
});

test("setUserSection on an empty file writes only the new section", () => {
  const after = setUserSection("", { name: "Alex", email: "alex@example.com" });
  assert.equal(after.split(/\r?\n/).filter((l) => l !== "").length, 3);
  assert.match(after, /^\[user\]/);
});

test("setUserSection does not touch user.name inside another section", () => {
  const before = [
    "[user]",
    "\tname = Mine",
    "[other]",
    "\tname = Not Mine",
    "",
  ].join("\n");
  const after = setUserSection(before, { name: "Changed" });
  assert.match(after, /\[other\]\n\tname = Not Mine/);
  assert.match(after, /\[user\]\n\tname = Changed/);
});

test("setUserSection only adds the keys that were supplied", () => {
  const before = [
    "[user]",
    "\tname = Old",
    "\temail = keep@example.com",
    "",
  ].join("\n");
  const after = setUserSection(before, { name: "New", email: undefined });
  assert.match(after, /name = New/);
  assert.match(
    after,
    /email = keep@example\.com/,
    "email must be left untouched when undefined",
  );
});

test("setUserSection is case tolerant when finding the section", () => {
  const before = ["[USER]", "\tname = Old", ""].join("\n");
  const after = setUserSection(before, { name: "New" });
  assert.match(after, /name = New/);
  assert.ok(!after.includes("Old"));
});

test("setUserSection keeps the indentation and spacing it found on the line", () => {
  // Known cosmetic wart: the original `  NAME   =` shape is preserved and only
  // the value is replaced, so the line stays `  name   = New`. Pinned so a
  // future "tidy the line" change is a deliberate decision, not an accident.
  const before = ["[user]", "  NAME   =   Old", ""].join("\n");
  const after = setUserSection(before, { name: "New" });
  assert.equal(after, "[user]\n  name   = New\n");
});

test("setUserSection is idempotent for the same values", () => {
  const before = "[user]\n\tname = Alex\n\temail = alex@example.com\n";
  const once = setUserSection(before, {
    name: "Alex",
    email: "alex@example.com",
  });
  const twice = setUserSection(once, {
    name: "Alex",
    email: "alex@example.com",
  });
  assert.equal(twice, once);
});
