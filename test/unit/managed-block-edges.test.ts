import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BEGIN_MARKER,
  END_MARKER,
  BlockError,
  contentHash,
  detectEol,
  findBlock,
  upsertBlock,
} from "../../src/core/managed-block.ts";

/**
 * `gs apply` edits files it does not own — ~/.gitconfig and ~/.ssh/config — and
 * everything it writes has to sit inside marked lines. A marker detection bug
 * is data loss for the user's own configuration, so the interesting cases are
 * the malformed ones: a half-deleted block, a block whose markers were
 * re-indented, two blocks, and CRLF files.
 *
 * `managed-block.test.ts` covers the happy paths; this file covers the edges.
 */

const BODY = "Host a\n\tHostName a.com";

/** The block body as written: the generated hash line comes first. */
const STAMPED_BODY = () => "# gs:hash " + contentHash(BODY) + "\n" + BODY;

function bodyFrom(text: string, body = BODY): string {
  return upsertBlock(text, body);
}

/* ------------------------------------------------------------------ */
/* detectEol                                                           */
/* ------------------------------------------------------------------ */

test("detectEol looks only at the first newline", () => {
  assert.equal(detectEol(""), "\n");
  assert.equal(detectEol("no newline"), "\n");
  assert.equal(
    detectEol("a\nb\r\n"),
    "\n",
    "a mixed file is treated as the first line ending",
  );
  assert.equal(detectEol("a\r\nb\n"), "\r\n");
  assert.equal(detectEol("\r\n"), "\r\n");
  // only the byte right before the first LF decides
  assert.equal(detectEol("a\r\r\n"), "\r\n");
});

/* ------------------------------------------------------------------ */
/* findBlock: malformed input is refused, never guessed at             */
/* ------------------------------------------------------------------ */

test("a file with no markers reports absent rather than broken", () => {
  for (const text of [
    "",
    "Host x\n",
    "# just a comment\n",
    "  # >>> gs:managed >>>\n",
  ]) {
    if (text.includes(BEGIN_MARKER)) continue;
    const block = findBlock(text);
    assert.equal(block.present, false, JSON.stringify(text));
    assert.equal(block.content, "");
    assert.equal(block.start, -1);
    assert.equal(block.end, -1);
    assert.equal(block.broken, false);
  }
});

test("BEGIN without END, END before BEGIN and a second END all refuse", () => {
  assert.throws(() => findBlock(`${BEGIN_MARKER}\nHost a\n`), BlockError);
  assert.throws(
    () => findBlock(`${BEGIN_MARKER}\nx\n`),
    /BEGIN marker without END marker/,
  );
  assert.throws(
    () => findBlock(`${END_MARKER}\nx\n`),
    /END marker before BEGIN marker/,
  );
  assert.throws(
    () => findBlock(`${END_MARKER}\n${BEGIN_MARKER}\n`),
    BlockError,
  );
  assert.throws(
    () => findBlock(`${BEGIN_MARKER}\nx\n${END_MARKER}\ny\n${END_MARKER}\n`),
    /more than one END marker/,
  );
});

test("two blocks are refused: choosing one would silently delete the other", () => {
  const twice = `${BEGIN_MARKER}\na\n${END_MARKER}\n${BEGIN_MARKER}\nb\n${END_MARKER}\n`;
  assert.throws(() => findBlock(twice), /more than one BEGIN marker/);
});

test("markers are recognised even when indented or padded", () => {
  const text = `  ${BEGIN_MARKER}  \n  Host a\n  ${END_MARKER}\t\n`;
  const block = findBlock(text);
  assert.equal(block.present, true);
  assert.equal(block.content, "  Host a\n");
});

test("a marker line embedded in other text is not a marker", () => {
  // Only a whole trimmed line counts; `# >>> gs:managed >>> extra` is user text.
  const text = "# >>> gs:managed >>> extra\nHost a\n";
  const block = findBlock(text);
  assert.equal(block.present, false);
});

test("a block surrounded by user content is located byte-exactly", () => {
  const text = `# top\nHost x\n\tHostName x.com\n\n${BEGIN_MARKER}\nHost a\n\tHostName a.com\n${END_MARKER}\n# bottom\n`;
  const block = findBlock(text);
  assert.equal(block.present, true);
  assert.equal(
    text.slice(block.start, block.end),
    `${BEGIN_MARKER}\nHost a\n\tHostName a.com\n${END_MARKER}\n`,
  );
  // the bytes outside the block are untouched
  assert.equal(
    text.slice(0, block.start),
    "# top\nHost x\n\tHostName x.com\n\n",
  );
  assert.equal(text.slice(block.end), "# bottom\n");
});

test("an empty block body is located and yields empty content", () => {
  const text = `${BEGIN_MARKER}\n${END_MARKER}\n`;
  const block = findBlock(text);
  assert.equal(block.present, true);
  assert.equal(block.content, "");
});

test("a CRLF block is located byte-exactly, CRs included", () => {
  const text = `# mine\r\n${BEGIN_MARKER}\r\nHost a\r\n${END_MARKER}\r\nafter\r\n`;
  const block = findBlock(text);
  assert.equal(block.present, true);
  // The content keeps its CRs on purpose: it is raw file content, and
  // upsertBlock re-normalises it when it rewrites the block.
  assert.equal(block.content, "Host a\r\n");
  assert.equal(
    text.slice(block.start, block.end),
    `${BEGIN_MARKER}\r\nHost a\r\n${END_MARKER}\r\n`,
  );
});

/* ------------------------------------------------------------------ */
/* upsertBlock: appending, replacing, removing                          */
/* ------------------------------------------------------------------ */

test("appending to an empty file produces only the block", () => {
  assert.equal(bodyFrom(""), `${BEGIN_MARKER}\n${STAMPED_BODY()}\n${END_MARKER}\n`);
});

test("appending separates the block from existing content by exactly one blank line", () => {
  assert.equal(
    bodyFrom("Host x\n"),
    `Host x\n\n${BEGIN_MARKER}\n${STAMPED_BODY()}\n${END_MARKER}\n`,
  );
  // a file that already ends with a blank line does not gain a second one
  assert.equal(
    bodyFrom("Host x\n\n"),
    `Host x\n\n${BEGIN_MARKER}\n${STAMPED_BODY()}\n${END_MARKER}\n`,
  );
  assert.equal(
    bodyFrom("Host x"),
    `Host x\n\n${BEGIN_MARKER}\n${STAMPED_BODY()}\n${END_MARKER}\n`,
  );
});

test("a CRLF file keeps CRLF throughout the generated block", () => {
  const out = bodyFrom("Host x\r\n");
  assert.ok(out.startsWith("Host x\r\n"));
  assert.ok(
    !/(?<!\r)\n/.test(out),
    `every LF must be preceded by CR:\n${JSON.stringify(out)}`,
  );
  assert.equal(detectEol(out), "\r\n");
});

test("an explicit eol overrides the detected one", () => {
  const out = upsertBlock("Host x\r\n", BODY, "\n");
  assert.equal(out, `Host x\r\n\n${BEGIN_MARKER}\n${STAMPED_BODY()}\n${END_MARKER}\n`);
});

test("replacing an existing block is idempotent for identical content", () => {
  const once = bodyFrom("# mine\n");
  assert.equal(bodyFrom(once), once);
  assert.equal(upsertBlock(once, BODY), once);
});

test("replacing keeps the surrounding content byte-for-byte", () => {
  const before = "# head\r\nHost x\r\n\tIdentityFile ~/.ssh/x\r\n";
  const after = "\n# tail\r\n";
  const text = `${before}${BEGIN_MARKER}\r\nstale\r\n${END_MARKER}\r\n${after}`;
  const out = upsertBlock(text, "Host new");
  assert.ok(out.startsWith(before), "the prefix is untouched, CRs included");
  assert.ok(out.endsWith(after), "the suffix is untouched");
  assert.ok(!out.includes("stale"));
  assert.ok(out.includes("Host new"));
});

test("a replacement with a trailing newline in the body does not add blank lines", () => {
  const text = `${BEGIN_MARKER}\nold\n${END_MARKER}\n`;
  assert.equal(
    upsertBlock(text, "new\n\n\n"),
    `${BEGIN_MARKER}\n# gs:hash ${contentHash("new")}\nnew\n${END_MARKER}\n`,
  );
  assert.equal(
    upsertBlock(text, "new\r\n"),
    `${BEGIN_MARKER}\n# gs:hash ${contentHash("new")}\nnew\n${END_MARKER}\n`,
  );
});

test("removing a block restores the file to what it was before it was appended", () => {
  const originals = ["", "Host x", "Host x\n", "# mine\r\nHost y\r\n"];
  for (const original of originals) {
    const withBlock = bodyFrom(original);
    const removed = upsertBlock(withBlock, null);
    if (original === "") {
      assert.equal(removed, "", "an empty file stays empty");
      continue;
    }
    // the normalised form: a missing trailing newline is not restored, but no
    // blank separator line is left over either
    const expected = original.endsWith("\n") ? original : original + "\n";
    assert.equal(removed, expected, `original ${JSON.stringify(original)}`);
  }
});

test("removal collapses a trailing blank line that the user added themselves", () => {
  // Known edge: the separator is identified by "two newlines before the block",
  // which cannot tell an appended separator from a user's blank line. Removing
  // the block therefore also removes one trailing newline. Pinned so the
  // behaviour is a decision rather than a surprise.
  const original = "Host x\n\n";
  const withBlock = bodyFrom(original);
  assert.equal(
    withBlock,
    `Host x\n\n${BEGIN_MARKER}\n${STAMPED_BODY()}\n${END_MARKER}\n`,
  );
  assert.equal(upsertBlock(withBlock, null), "Host x\n");
});

test("removal by an empty string body behaves exactly like null", () => {
  const withBlock = bodyFrom("Host x\n");
  assert.equal(upsertBlock(withBlock, ""), upsertBlock(withBlock, null));
  assert.equal(upsertBlock(withBlock, "\n"), upsertBlock(withBlock, null));
  // whitespace is content: it produces a block holding a single blank line
  assert.equal(
    upsertBlock(withBlock, "  \n"),
    `Host x\n\n${BEGIN_MARKER}\n# gs:hash ${contentHash("  ")}\n  \n${END_MARKER}\n`,
  );
});

test("removing the only content of a file leaves it empty rather than blank", () => {
  const text = `${BEGIN_MARKER}\n${STAMPED_BODY()}\n${END_MARKER}\n`;
  assert.equal(upsertBlock(text, null), "");
});

test("removing a block from a CRLF file does not leave a bare LF", () => {
  const original = "Host x\r\n";
  const withBlock = bodyFrom(original);
  const removed = upsertBlock(withBlock, null);
  assert.equal(removed, original);
  assert.ok(!/(?<!\r)\n/.test(removed), JSON.stringify(removed));
});

test("removing a block that has no separator does not eat the preceding line", () => {
  // A block written to an empty file, then the user adds a line above it by hand.
  const text = `Host x\n${BEGIN_MARKER}\n${STAMPED_BODY()}\n${END_MARKER}\n`;
  assert.equal(upsertBlock(text, null), "Host x\n");
});

test("upsertBlock refuses to touch a file with a half-deleted block", () => {
  // Silently appending a second block would leave two BEGIN markers and every
  // later run would fail with a confusing "more than one marker" message.
  assert.throws(
    () => upsertBlock(`${BEGIN_MARKER}\nstale\n`, BODY),
    BlockError,
  );
});

test("an upsert with an empty body does not create a block in a file without one", () => {
  const text = "Host x\n";
  assert.equal(upsertBlock(text, null), text);
  assert.equal(upsertBlock(text, ""), text);
});

/* ------------------------------------------------------------------ */
/* contentHash                                                         */
/* ------------------------------------------------------------------ */

test("contentHash pins the FNV-1a 32-bit values for known inputs", () => {
  // A different algorithm would silently invalidate every hash recorded in an
  // existing state file, so pin concrete outputs rather than only the shape.
  assert.equal(contentHash(""), "811c9dc5");
  assert.equal(contentHash("a"), "e40c292c");
  assert.equal(contentHash("abc"), "1a47e90b");
  assert.equal(contentHash("ü"), "790b80bb");
  assert.match(contentHash("anything"), /^[0-9a-f]{8}$/);
});

test("contentHash distinguishes content that differs only by line endings", () => {
  assert.notEqual(contentHash("a\nb"), contentHash("a\r\nb"));
});

test("contentHash handles a very long string without throwing", () => {
  const long = "x".repeat(500_000);
  assert.match(contentHash(long), /^[0-9a-f]{8}$/);
});

test("contentHash is stable across calls (no hidden state)", () => {
  const value = "Host a\n\tHostName a.com";
  assert.equal(contentHash(value), contentHash(value));
  assert.equal(contentHash(value), contentHash(`${value}`));
});
