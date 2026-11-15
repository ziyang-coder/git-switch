import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parse,
  stringify,
  formatScalar,
  needsQuoting,
  YamlError,
  type YamlValue,
} from "../../src/core/yaml.ts";

/**
 * The hand-written YAML subset is what stands between a hand-edited
 * `profiles.yaml` and a silently wrong identity mapping. Two failure modes
 * matter here and both are covered below:
 *
 *   1. input the parser does not understand must be **rejected**, never
 *      misparsed (a misparsed rule would point at the wrong identity);
 *   2. anything `stringify` writes must parse back to the identical value,
 *      otherwise `gs apply` after a GUI/CLI save loses data.
 */

/* ------------------------------------------------------------------ */
/* document level                                                      */
/* ------------------------------------------------------------------ */

test("an empty, whitespace-only or comment-only document parses to {}", () => {
  for (const source of [
    "",
    "   ",
    "\n\n\n",
    "\t\n  \n",
    "# only a comment\n",
    "# a\n   # b\n",
  ]) {
    assert.deepEqual(parse(source), {}, `source ${JSON.stringify(source)}`);
  }
});

test("a UTF-8 BOM is stripped rather than becoming part of the first key", () => {
  const doc = parse("\uFEFFschemaVersion: 1\n");
  // Without the strip, the key would be "\uFEFFschemaVersion" and the profile
  // would fail with a baffling "missing schemaVersion".
  assert.deepEqual(Object.keys(doc), ["schemaVersion"]);
  assert.equal(doc.schemaVersion, 1);
});

test("CRLF input parses exactly like LF input", () => {
  const lf = "a:\n  - b: 1\n    c: two\n";
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.deepEqual(parse(crlf), parse(lf));
  assert.deepEqual(parse(crlf), { a: [{ b: 1, c: "two" }] });
});

test("a document may not start with indentation", () => {
  assert.throws(() => parse("  a: 1\n"), YamlError);
  assert.throws(
    () => parse("  a: 1\n"),
    /document must start at indentation 0/,
  );
});

test("a top-level sequence is rejected: profiles.yaml must be a mapping", () => {
  assert.throws(() => parse("- a\n- b\n"), /top level must be a mapping/);
});

test("a tab used for indentation is rejected with the offending line number", () => {
  try {
    parse("a:\n\tb: 1\n");
    assert.fail("a tab indent must be rejected");
  } catch (err) {
    assert.ok(err instanceof YamlError);
    assert.equal(err.line, 2);
    assert.match(err.message, /YAML line 2: tabs are not allowed/);
  }
});

test("odd indentation is rejected instead of being rounded down", () => {
  assert.throws(
    () => parse("a:\n   b: 1\n"),
    /indentation must be a multiple of 2 spaces/,
  );
});

test("a line indented deeper than its parent is rejected", () => {
  assert.throws(() => parse("a: 1\n  b: 2\n"), /unexpected indentation/);
});

test("an unindented line after a nested block starts a new top-level key", () => {
  // `b` is a sibling of `a`, not a child of it.
  assert.deepEqual(parse("a:\n  x: 1\nb: 2\n"), { a: { x: 1 }, b: 2 });
});

/* ------------------------------------------------------------------ */
/* scalars                                                             */
/* ------------------------------------------------------------------ */

test("reserved plain scalars map to their YAML types", () => {
  assert.deepEqual(parse("a: null\nb: ~\nc: true\nd: false\ne: 42\nf: -7\n"), {
    a: null,
    b: null,
    c: true,
    d: false,
    e: 42,
    f: -7,
  });
});

test("a key with no value is null, and so is an explicitly empty value", () => {
  assert.deepEqual(parse('a:\nb: \nc: ""\n'), { a: null, b: null, c: "" });
});

test("only the exact lowercase reserved words are special", () => {
  // `True`, `NULL`, `~x` are plain strings in this subset. Treating them as
  // booleans/null would silently change a user name or a path.
  assert.deepEqual(parse("a: True\nb: NULL\nc: ~x\nd: yes\n"), {
    a: "True",
    b: "NULL",
    c: "~x",
    d: "yes",
  });
});

test("integers with leading zeros and signs are parsed as numbers", () => {
  const doc = parse("a: 007\nb: -0\nc: +1\n");
  assert.equal(doc.a, 7);
  assert.equal(
    doc.c,
    "+1",
    'a leading "+" is not accepted by the integer rule',
  );
  // `-0` is parsed by Number.parseInt and therefore becomes the number -0, which
  // is distinguishable from 0 under strict equality. Pin it so a change in the
  // number grammar shows up rather than silently reshaping a value.
  assert.ok(Object.is(doc.b, -0), "a -0 literal is parsed as the number -0");
});

test("floats are NOT turned into numbers by this subset", () => {
  // Profile fields are strings, ints or host names; a float only ever appears as
  // text, so keeping "1.5" a string avoids a surprise Number round-trip.
  const doc = parse("a: 1.5\n");
  assert.equal(doc.a, "1.5");
  assert.equal(typeof doc.a, "string");
});

test('a value containing a colon is only split at "colon followed by space"', () => {
  assert.deepEqual(
    parse("url: https://github.com/owner/repo.git\ntime: 12:30\n"),
    {
      url: "https://github.com/owner/repo.git",
      time: "12:30",
    },
  );
});

test("a trailing comment is stripped only outside quotes", () => {
  assert.deepEqual(
    parse(
      `a: value # gone\nb: "keep # me"\nc: 'keep # me too'\nd: keep#notacomment\n`,
    ),
    {
      a: "value",
      b: "keep # me",
      c: "keep # me too",
      d: "keep#notacomment",
    },
  );
});

test("a comment marker inside a quoted scalar does not end the scalar", () => {
  // The quote tracker must survive an odd number of quote characters so the
  // "#" is not mistaken for the start of a comment.
  assert.deepEqual(parse(`a: "it's # fine"\n`), { a: "it's # fine" });
});

/* ------------------------------------------------------------------ */
/* quoting and escapes                                                 */
/* ------------------------------------------------------------------ */

test('single-quoted scalars keep quotes literal and "" is a single quote', () => {
  assert.deepEqual(parse(`a: 'C:\\code\\x'\nb: 'it''s'\n`), {
    a: "C:\\code\\x",
    b: "it's",
  });
});

test('double-quoted scalars honour n, t, " and backslash escapes', () => {
  assert.deepEqual(
    parse(
      `a: "line1\\nline2"\nb: "tab\\there"\nc: "quote\\"inside"\nd: "back\\\\slash"\n`,
    ),
    {
      a: "line1\nline2",
      b: "tab\there",
      c: 'quote"inside',
      d: "back\\slash",
    },
  );
});

test("an unsupported escape sequence is rejected rather than passed through", () => {
  assert.throws(() => parse(`a: "x\\qy"\n`), /unsupported escape sequence \\q/);
});

test("an unterminated quote is rejected", () => {
  assert.throws(
    () => parse(`a: "unterminated\n`),
    /unterminated quoted scalar/,
  );
  assert.throws(
    () => parse(`a: 'unterminated\n`),
    /unterminated quoted scalar/,
  );
  assert.throws(() => parse(`a: "\n`), /unterminated quoted scalar/);
});

/* ------------------------------------------------------------------ */
/* structure                                                           */
/* ------------------------------------------------------------------ */

test("nested mappings two and three levels deep", () => {
  assert.deepEqual(parse("a:\n  b:\n    c: 1\n"), { a: { b: { c: 1 } } });
});

test("a sequence of mappings with a nested keyword list", () => {
  assert.deepEqual(
    parse("sites:\n  - host: github.com\n    port: 22\n  - host: gitee.com\n"),
    {
      sites: [{ host: "github.com", port: 22 }, { host: "gitee.com" }],
    },
  );
});

test("a sequence item whose nested block is a list", () => {
  assert.deepEqual(parse("a:\n  - b:\n      - 1\n      - 2\n"), {
    a: [{ b: [1, 2] }],
  });
});

test("an empty sequence item is null, not an empty string", () => {
  assert.deepEqual(parse("a:\n  -\n  - b\n"), { a: [null, "b"] });
});

test("inline flow sequences parse, including quoted commas and trailing comma", () => {
  assert.deepEqual(parse('a: [x, "y, z", 1]\nb: []\nc: [1, 2,]\n'), {
    a: ["x", "y, z", 1],
    b: [],
    c: [1, 2],
  });
});

test("an inline flow mapping does not support a flow sequence as its value", () => {
  // Documented limitation turned into an assertion: the nested `[1, 2]` used to
  // be silently mangled (`{ a: { b: '2]' } }`) rather than rejected. Whatever the
  // parser does here, it must never invent a value — it must fail loudly.
  assert.throws(() => parse("a: { b: [1, 2] }\n"), YamlError);
});

test("a duplicate key is rejected at every level instead of silently losing data", () => {
  assert.throws(() => parse("a: 1\na: 2\n"), /duplicate key "a"/);
  assert.throws(() => parse("a:\n  b: 1\n  b: 2\n"), /duplicate key "b"/);
  assert.throws(() => parse("a:\n  - b: 1\n    b: 2\n"), /duplicate key "b"/);
});

test("a line that is neither key: value nor a list item is rejected", () => {
  assert.throws(() => parse("just a bare line\n"), /expected "key: value"/);
});

test("an empty key is rejected", () => {
  assert.throws(() => parse(": value\n"), /empty key/);
});

/* ------------------------------------------------------------------ */
/* unsupported YAML features are refused, not misparsed                */
/* ------------------------------------------------------------------ */

test("block scalars are rejected with a clear message", () => {
  assert.throws(
    () => parse("a: |\n  x\n  y\n"),
    /block scalars \(\| and >\) are not supported/,
  );
  assert.throws(() => parse("a: >\n  x\n"), /block scalars/);
});

test("an anchor or alias used as a key is rejected", () => {
  assert.throws(
    () => parse("&x: 1\n"),
    /anchors and aliases are not supported/,
  );
  assert.throws(
    () => parse("*x: 1\n"),
    /anchors and aliases are not supported/,
  );
});

test("an anchor or alias used as a value becomes a literal string", () => {
  // Documented gap in the guard: the `&`/`*` check only looks at the start of a
  // line, so a value-side anchor is stored verbatim. Pin the current shape so
  // that a profile can never *silently* gain YAML syntax in a field: whoever
  // changes this must decide whether to reject it or keep the literal.
  assert.deepEqual(parse("a: &anchor 1\n"), { a: "&anchor 1" });
  assert.deepEqual(parse("a: *alias\n"), { a: "*alias" });
});

test("a leading document separator is accepted and dropped", () => {
  // REGRESSION TEST for a real defect. parse() has an explicit branch for this
  // (yaml.ts:301-303) whose body is empty — it recognises `---` and then does
  // nothing, so the separator falls through to splitKeyValue and the user gets
  //   YAML line 1: expected "key: value", got "---"
  // for a file every YAML editor is happy to produce. The comment says
  // "single-document files are fine; drop the separator"; it does not drop it.
  //
  // Expected: { a: 1 }          Actual: YamlError "expected key: value, got ---"
  assert.deepEqual(parse("---\na: 1\n"), { a: 1 });
});

test("a document separator anywhere in the file is rejected rather than half-parsed", () => {
  // A leading `---` is the common case (see above); a later one would mean two
  // documents, which this subset genuinely does not support.
  assert.throws(() => parse("a: 1\n---\nb: 2\n"), YamlError);
});

test("unexpected content after the document is rejected", () => {
  assert.throws(
    () => parse("a: 1\n- b\n"),
    /unexpected content after document/,
  );
});

/* ------------------------------------------------------------------ */
/* serialisation                                                       */
/* ------------------------------------------------------------------ */

test("needsQuoting flags every value that would otherwise change meaning", () => {
  const mustQuote = [
    "",
    "null",
    "~",
    "true",
    "false",
    "123",
    "-7",
    " padded",
    "padded ",
    "a: b",
    "a #b",
    "#leading",
    "a,b",
    "[x]",
    "{x}",
    "-dash",
    "?question",
    "@at",
    "pipe|x",
    "gt>",
    "tick`",
    "pct%",
    "amp&",
    "star*",
    "bang!",
    "single'",
    'double"',
  ];
  for (const value of mustQuote) {
    assert.equal(
      needsQuoting(value),
      true,
      `${JSON.stringify(value)} must be quoted`,
    );
  }
  for (const value of [
    "plain",
    "a-b",
    "a_b",
    "/home/u",
    "1.5",
    "yes",
    "on",
    "off",
  ]) {
    assert.equal(
      needsQuoting(value),
      false,
      `${JSON.stringify(value)} should stay plain`,
    );
  }
});

test("paths are quoted even when that is not strictly required", () => {
  // `:` is in the "safe characters" set only because a plain scalar may contain
  // it; quoting anyway is harmless and makes the file read unambiguously.
  assert.equal(needsQuoting("C:/code/x"), true);
  assert.equal(needsQuoting("a@example.com"), true);
});

test("formatScalar renders each scalar type unambiguously", () => {
  assert.equal(formatScalar(null), "null");
  assert.equal(formatScalar(true), "true");
  assert.equal(formatScalar(false), "false");
  assert.equal(formatScalar(0), "0");
  assert.equal(formatScalar(-12), "-12");
  assert.equal(formatScalar("it's"), "'it''s'");
  assert.equal(formatScalar("plain"), "plain");
});

test("stringify ends with exactly one newline and writes empty collections inline", () => {
  const text = stringify({ a: [], b: {}, c: 1 });
  assert.equal(text, "a: []\nb: {}\nc: 1\n");
});

test('stringify omits undefined members instead of writing "key: undefined"', () => {
  assert.equal(
    stringify({ a: 1, b: undefined as unknown as YamlValue }),
    "a: 1\n",
  );
});

test("a value containing a newline is quoted so the output can be parsed back", () => {
  // REGRESSION TEST for a real defect. `needsQuoting` only tests for
  // `[:#[\\]{},&*!|>'\"%@`]` and leading/trailing whitespace — never an embedded
  // "\\n" or "\\r". `formatScalar` therefore writes `k: a<LF>b` and the result
  // cannot be read back at all:
  //   YAML line 2: expected "key: value", got "b"
  // Nothing in profiles.yaml forbids a newline in a comment, and the GUI sends
  // whatever the user typed, so one paste of a multi-line note makes the file
  // unloadable — and `saveProfiles` has already overwritten it.
  //
  // Expected: round-trips (e.g. as 'a\nb' / "a\\nb")
  // Actual:   the written file cannot be parsed
  assert.equal(
    needsQuoting("a\nb"),
    true,
    "an embedded newline must force quoting",
  );
  const written = stringify({ k: "a\nb" });
  assert.deepEqual(
    parse(written),
    { k: "a\nb" },
    `written as ${JSON.stringify(written)}`,
  );
});

test("a value containing a carriage return is quoted or escaped", () => {
  // Same defect as above for "\\r": it survives here only because a lone CR does
  // not split a line, but it silently travels through the file.
  assert.equal(needsQuoting("a\rb"), true, "an embedded CR must force quoting");
});

/**
 * Round-trip matrix. Each value is written by `stringify` and read back with
 * `parse`; the two must be identical. This is the property that keeps
 * `profiles.yaml` stable across a save by the CLI or the GUI.
 */
const ROUNDTRIP_VALUES: YamlValue[] = [
  null,
  true,
  false,
  0,
  -1,
  65535,
  "",
  "plain",
  "with spaces",
  " padded",
  "trailing ",
  "null",
  "~",
  "true",
  "1.5",
  "yes",
  "on",
  "a: b",
  "a #b",
  "#",
  ":",
  "-",
  "?",
  "@user",
  "%width",
  "`tick",
  "a&b",
  "*star",
  "!bang",
  "pipe|",
  "gt>",
  "comma,",
  "flow[x]",
  "flow{y}",
  "it's",
  'say "hi"',
  "C:/code/x",
  "C:\\code\\x",
  "\\\\\\\\server\\share",
  "user@example.com",
  "/home/a/../b",
  "tab\there",
  "line\rreturn",
  "中文目录",
  "emoji 🚀",
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "x".repeat(4096),
];

test("every scalar survives a stringify/parse round trip", () => {
  for (const value of ROUNDTRIP_VALUES) {
    const text = stringify({ k: value });
    let parsed: { [key: string]: YamlValue };
    try {
      parsed = parse(text);
    } catch (err) {
      assert.fail(
        `parse failed for ${JSON.stringify(value)} written as ${JSON.stringify(text)}: ${(err as Error).message}`,
      );
    }
    assert.equal(
      parsed.k,
      value,
      `round trip changed ${JSON.stringify(value)} (written as ${JSON.stringify(text)})`,
    );
  }
});

test("a nested profile-shaped document round-trips unchanged", () => {
  const doc: { [key: string]: YamlValue } = {
    schemaVersion: 1,
    identities: {
      personal: {
        user: { name: "Alex Chen", email: "alex@personal.example" },
        sshKey: "id_ed25519_github",
        sites: [
          {
            host: "github.com",
            port: 22,
            alias: "gh",
            alsoRoutes: ["ghe.example"],
          },
        ],
      },
    },
    rules: [
      { dir: "C:/code/personal", identity: "personal", comment: "it's #1: ok" },
      { dir: "/home/u/code/work", identity: "personal" },
    ],
    settings: { backupKeep: 5, allowRoots: [] },
  };
  assert.deepEqual(parse(stringify(doc)), doc);
});

test("stringify -> parse -> stringify is byte-stable (no drift on repeated saves)", () => {
  const doc: { [key: string]: YamlValue } = {
    a: [{ b: [1, 2], c: { d: "x y" } }],
    e: null,
    f: "quote'inside",
  };
  const first = stringify(doc);
  const second = stringify(parse(first));
  assert.equal(second, first);
});
