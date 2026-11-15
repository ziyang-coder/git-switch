/**
 * Containment tests for the snapshot endpoints' filesystem paths.
 *
 * `POST /api/snapshot/export` and `/api/snapshot/import` take a filesystem path
 * from the request body. A token holder (anything running in the user's browser
 * session, including a compromised renderer) must not be able to use those paths
 * to read or write outside the gs home.
 *
 * `server-security.test.ts` covers the lexical cases (`..`, absolute paths,
 * mixed separators). A path that is lexically *inside* home can still resolve
 * outside it when the home contains a directory link — junction on Windows,
 * symlink elsewhere — so these tests create the link and check the bytes that
 * actually land on disk.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTmpHome } from "../helpers/tmp-home.ts";
import { startServer, type RunningServer } from "../../src/server/http.ts";

const posix = (p: string) => p.replace(/\\/g, "/");
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

const PROFILE = `schemaVersion: 1
identities:
  work:
    user:
      name: Alex Chen
      email: alex@company.example
rules: []
`;

/**
 * Create a directory link inside `home` that points at `target`.
 *
 * A plain symlink needs a privilege Windows does not grant by default, so fall
 * back to a junction there; both are followed by Node's `fs` and by the server.
 * Returns the link name, or `undefined` when the platform refuses every form —
 * the caller then skips (a machine that cannot make a link cannot be attacked
 * this way either).
 */
async function makeDirLink(
  home: string,
  name: string,
  target: string,
): Promise<string | undefined> {
  const linkPath = path.join(home, name);
  for (const type of ["dir", "junction"] as const) {
    try {
      await symlink(target, linkPath, type);
      return name;
    } catch {
      // try the next form
    }
  }
  return undefined;
}

async function withServer(
  fn: (ctx: {
    home: string;
    post: (endpoint: string, body: unknown) => Promise<Response>;
  }) => Promise<void>,
): Promise<void> {
  const h = await createTmpHome("gs-link-");
  let server: RunningServer | undefined;
  try {
    await h.write(".config/gs/profiles.yaml", PROFILE);
    server = await startServer({ home: h.home });
    const base = `http://127.0.0.1:${server.port}`;
    const auth = { "x-gs-token": server.token };
    await fn({
      home: h.home,
      post: (endpoint, body) =>
        fetch(`${base}${endpoint}`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
        }),
    });
  } finally {
    if (server) await server.close();
    await h.cleanup();
  }
}

test("security: snapshot export cannot escape home through a directory link", async (t) => {
  const outside = await createTmpHome("gs-link-outside-");
  try {
    await withServer(async ({ home, post }) => {
      const link = await makeDirLink(home, "out", outside.home);
      if (!link) {
        t.skip(
          "this platform refuses to create a directory link; the escape needs one",
        );
        return;
      }

      const res = await post("/api/snapshot/export", {
        path: `${link}/escaped.gsnap`,
      });
      const written = await readFile(
        path.join(outside.home, "escaped.gsnap"),
        "utf8",
      ).catch(() => undefined);
      assert.equal(
        written,
        undefined,
        "snapshot/export followed a directory link out of home and wrote " +
          `there (answered ${res.status}); a lexically-inside path must not escape at resolve time`,
      );
      assert.equal(
        res.status,
        400,
        `the escape must be refused with 400, got ${res.status}`,
      );
    });
  } finally {
    await outside.cleanup();
  }
});

test("security: snapshot import cannot read a directory link out of home", async (t) => {
  const outside = await createTmpHome("gs-link-outside-");
  try {
    await withServer(async ({ home, post }) => {
      const link = await makeDirLink(home, "out", outside.home);
      if (!link) {
        t.skip(
          "this platform refuses to create a directory link; the escape needs one",
        );
        return;
      }

      // Build a valid archive inside home, then copy it to the outside directory
      // and try to import it through the link.
      const exported = await post("/api/snapshot/export", {
        path: "inside.gsnap",
      });
      await exported.text();
      const archive = await readFile(path.join(home, "inside.gsnap"), "utf8");

      const content =
        "schemaVersion: 1\nidentities:\n  foreign:\n    user:\n      name: Foreign\n      email: foreign@example.com\nrules: []\n";
      const payload = JSON.parse(archive) as {
        manifest: { files: unknown[] };
        files: unknown[];
      };
      const hash = sha256(content);
      payload.manifest.files = [{ path: "profiles.yaml", sha256: hash }];
      payload.files = [{ path: "profiles.yaml", content, sha256: hash }];
      await writeFile(
        path.join(outside.home, "foreign.gsnap"),
        JSON.stringify(payload),
        "utf8",
      );

      // `/api/snapshot/export` refuses to write through the link, so plant the
      // archive with a direct filesystem write to model "a file that a different
      // process put outside home".
      const before = await readFile(
        path.join(home, ".config/gs/profiles.yaml"),
        "utf8",
      );
      const res = await post("/api/snapshot/import", {
        path: `${link}/foreign.gsnap`,
      });
      const after = await readFile(
        path.join(home, ".config/gs/profiles.yaml"),
        "utf8",
      );
      assert.equal(
        after,
        before,
        "snapshot/import followed a directory link out of home and replaced the profile from an " +
          `archive there (answered ${res.status})`,
      );
      assert.equal(
        res.status,
        400,
        `the escape must be refused with 400, got ${res.status}`,
      );
    });
  } finally {
    await outside.cleanup();
  }
});

test("security: snapshot export still writes normally inside home", async () => {
  await withServer(async ({ home, post }) => {
    await mkdir(path.join(home, "backups"), { recursive: true });
    const res = await post("/api/snapshot/export", {
      path: "backups/plain.gsnap",
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { path: string };
    assert.equal(
      posix(body.path).endsWith("backups/plain.gsnap"),
      true,
      "a normal subdirectory must keep working",
    );
    const text = await readFile(
      path.join(home, "backups", "plain.gsnap"),
      "utf8",
    );
    assert.ok(text.length > 0);
  });
});
