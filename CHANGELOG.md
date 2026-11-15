# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-11-15

### Fixed

- **`includeIf "gitdir:"` rules now match through a symbolic link.** git compares
  the pattern against the repository's *resolved* path. On macOS every temporary
  directory is `/var/folders/…`, a symlink to `/private/var/folders/…`, so a rule
  written through the link never matched: `includeIf` silently did nothing and the
  global identity won every repository. `realCasePath` resolves the path before
  aligning casing; a directory that does not exist yet still falls back to the
  literal path, so rules for future checkouts keep working.
- **`gs version` reports the author, licence and repository, and each build names
  its commit.** The version carries SemVer build metadata — `0.1.1+42.gabc1234` —
  plus `.dirty` when the tree had uncommitted changes. `gs --version` and
  `gs version --short` still print the bare line; `--json` emits everything.

### Added

- **The package is publishable to npm.** It is now named `@zhulij/git-switch`
  (the unscoped `git-switch` is taken by an unrelated project), declares
  `publishConfig` with public access against the official registry, and ships only
  `dist/` plus the docs. `npm run prepublish:verify` runs 30 checks — package
  identity, zero runtime dependencies, no `.ts` in the tarball, no `src/` or
  `test/`, and it installs the tarball into a throw-away prefix and runs
  `gs version` — before anything reaches the registry.
- [docs/publishing.md](docs/publishing.md) and its Chinese counterpart document the
  release procedure, including the two traps this machine has: the default registry
  is a read-only mirror, and version numbers can never be reused.
- **Bilingual CLI and GUI (English / Simplified Chinese)**, driven by one catalogue.
  Language precedence is `--lang` → `GS_LANG` → the OS locale → English, and the
  GUI has a picker in the header.
- **`gs add [dir] --identity <name>`** binds a directory to an identity from the
  CLI, sharing its implementation with the GUI rule editor.
- **The GUI covers every CLI command** — keys (list, generate, copy, rename,
  restore), identities (add, edit, delete), rules, preview, diagnostics, snapshots
  and first-run setup — and shows the running build behind an About menu.
- **Editing an identity keeps the site fields the form does not show**, so
  `sshHostName` (GitHub over `ssh.github.com:443`) is no longer dropped on save.

### Changed

- **Rule matching uses the longest matching directory**, as the schema always
  documented, instead of the first rule in array order.
- **Forms are grouped and labelled**: identity → key → site, directory → identity,
  with every control carrying a visible label and required fields marked.

### Added

- **The package is publishable to npm.** It is now named `@zhulij/git-switch`
  (the unscoped `git-switch` is taken by an unrelated project), declares
  `publishConfig` with public access against the official registry, and ships only
  `dist/` plus the docs. `npm run prepublish:verify` runs 30 checks — package
  identity, zero runtime dependencies, no `.ts` in the tarball, no `src/` or
  `test/`, and it installs the tarball into a throw-away prefix and runs
  `gs version` — before anything reaches the registry.
- [docs/publishing.md](docs/publishing.md) and its Chinese counterpart document the
  release procedure, including the two traps this machine has: the default registry
  is a read-only mirror, and version numbers can never be reused.

### Fixed

- **`apply` no longer confuses a profile change with a hand edit — and now
  actually catches hand edits.** The first attempt at protecting user edits
  compared the block against what would be generated, so removing a rule or a
  site (lines that legitimately disappear) was reported as a hand edit and
  `gs apply` refused; conversely a permissive variant let a hand-written
  `ProxyJump` be silently deleted. The block now records a hash of the body it was
  generated from: a profile change matches it, any edit does not. `--force`
  finally reaches that decision, which is what the error message always told users
  to use.
- **`--json` emits a document even when the command fails**, including when the
  profile is missing or malformed. Previously stdout was empty and the only
  explanation was a human sentence on stderr, forcing scripts to parse prose.
- **Snapshot path containment survives directory links.** The check compared
  strings, so a junction inside the home pointing outside let `export` write and
  `import` read anywhere the user can. Both sides now resolve real paths.
- **Sub-command arity is enforced per sub-command**, so `gs key list EXTRA` is a
  usage error instead of silently ignoring the operand.
- **A profile could be written in a form `gs` itself could not read back.**
  `needsQuoting` never looked for embedded newlines, so a value containing one was
  emitted as a literal line break: `saveProfiles` overwrote the file with YAML that
  failed to parse, and the original was gone. Such values are now escaped
  double-quoted scalars (and `\r` was added to the parser's escape table). A leading
  `---` document separator is accepted instead of rejected.
- **Snapshot paths could escape the home directory.** `POST /api/snapshot/export`
  and `/import` resolved the request's `path` with no containment check, so a token
  holder could write to `~/.ssh/authorized_keys` or read any archive the user can.
  Both now refuse a path outside the home directory.
- **An invalid `host` could brick the whole profile.** The identity update path did
  not validate it, so `not a host!` was persisted and afterwards no `gs` command
  could load the profile. Add and update both validate before mutating.
- **Concurrent writes lost data.** Every mutating endpoint did an unsynchronised
  read-modify-write: two overlapping requests read the same snapshot and the second
  save silently discarded the first, both reporting `200`. Writes are serialised
  per home.
- **`apply()` destroyed hand edits inside a managed block.** It documents that it
  refuses; in practice the block was regenerated wholesale. The plan now reports an
  error naming the offending lines and `apply` stops.
- **The hand-edit guard mistook ordinary `gs` operations for hand edits.** A block
  line is "hand edited" when it is not in the freshly rendered body, so *removing*
  a rule, dropping a site, re-pointing a rule or changing a site's port all looked
  exactly like a hand edit: `gs apply` refused with exit 2 and the new configuration
  could never be written. The guard now compares lines that disappear from the block
  against the previous profile, so only content the generator never produced is
  protected.
- **`apply --force` did not override the hand-edit guard.** The error told the user
  to "re-run with --force", and `gs help` documents `--force` as "overwrite managed
  blocks edited by hand", but the check ran in `plan()` where `--force` is not
  visible, so `gs apply --force` failed with the same error in a loop. `--force` is
  now threaded through to the plan.
- **An unreadable target file aborted the entire plan.** `plan()` read each file
  outside its try/catch, so a path that was a directory rejected the whole call
  instead of becoming a per-file error, and `gs apply` wrote nothing at all.
- **`sshKey: ..` escaped `~/.ssh`.** The key-name pattern accepted `.` and `..`,
  which `path.join` resolves outside the directory.
- **A misspelled flag silently did the dangerous thing.** `gs apply --dryrun` (one
  hyphen short) was collected as an unknown flag and ignored, so the command
  *applied* the change the user meant to preview. Unknown flags, a value flag
  swallowing the next flag, and unexpected trailing operands are now usage errors.
  A stray operand after an unqualified subcommand (`gs key list typo`) is covered
  by the same check.
- **Errors printed stack traces.** `gs gui --port abc` raised
  `ERR_SOCKET_BAD_PORT` with a Node stack; a directory where a config file belongs
  surfaced raw `EISDIR` frames. Messages are printed, `GS_DEBUG=1` restores the
  stack, and `--json` emits a document even on failure.
- **Snapshot paths could still escape home through a directory link.** The
  containment check compared path strings, so a path that was lexically inside the
  home but passed through a junction or symlink pointing elsewhere still read and
  wrote there. Both endpoints now resolve the real path before comparing.
- **Colour leaked into pipes.** `NO_COLOR` was ignored and a redirected stdout still
  contained ANSI escapes; colour now requires a TTY.
- **The GUI showed stale labels and crashed on partial data.** `<html lang>` stayed
  `en` after switching to Chinese, the status-bar counts were not re-rendered on a
  language change, and a partial `/api/state` response threw a `TypeError` that
  blanked the overview and identities screens. Every form control that relied on a
  placeholder now has an accessible name.
- **The About menu rendered raw keys (`version.author`, `version.license`, …)
  instead of labels.** The catalogue sent to the browser only carried `web.*`, so
  every `version.*` string the menu asked for fell back to its key name. The
  allow-list is now explicit (`web.` and `version.`) instead of a single hard-coded
  prefix, and a test scans the frontend for `t('…')` calls and fails if any key
  the UI uses is missing from either the English or the Chinese payload.
- **The GUI's status bar stayed on “加载中…” forever.** The element carried
  `data-i18n="web.loading"`, so every call to `translateChrome()` re-wrote it —
  including the call that runs while rendering the first screen, which happens
  *after* `boot()` has filled in the identity/rule counts. The status text is
  dynamic, so it no longer carries `data-i18n`, `boot()` sets the loading text
  explicitly, and the counts are written after the first render so nothing can
  overwrite them.
- **Editing an identity silently dropped `sshHostName`, which broke `git push`
  to GitHub.** The editor rebuilt the site from the fields it showed, so a site
  configured as `github.com` via `ssh.github.com:443` lost the endpoint and became
  `HostName github.com` + `Port 443`. That endpoint *authenticates* (`ssh -T`
  succeeds) but drops the connection as soon as git requests a pack, producing a
  confusing `Connection closed by … port 443`. Now:
  - fields the form does not show (`user`, `sshHostName`, `alsoRoutes`, `sshKey`)
    are preserved on every edit;
  - the form exposes *SSH hostname* and *SSH user* explicitly;
  - a URL in *SSH hostname* is rejected instead of stored.
- **One invalid field no longer blanks the whole GUI.** A site host pasted as a
  URL (`http://host:9090/`) made `loadProfiles` throw, `/api/state` answered 400,
  and every screen rendered empty with no explanation — and `gs gui` refused to
  start at all. Now:
  - `/api/state` degrades: it returns `200` with empty lists plus `profileError`
    carrying the exact field and message, so every tab still renders;
  - the page shows that error in a banner above all screens, with a reload button;
  - `gs gui` starts on a broken profile (it still refuses when the profile is
    missing entirely, which is a `gs init` situation).
- **`gs gui --home` looks exactly like the real GUI, so a user could configure an
  identity in a sandbox and be confused when their real `~/.ssh` never changed.**
  The command now prints the home it operates on and warns explicitly when it is
  not the real one (`--json` includes `home` and `sandbox` fields), and the page
  shows a persistent banner naming the home — red for a sandbox, neutral for the
  real home. The banner survives tab switches and can be dismissed.
- **The GUI could not be opened at all.** `gs gui` printed a URL like
  `http://127.0.0.1:PORT/#token=…`, but the server required the token for the
  index page too. A browser never sends the URL fragment, so the first request
  for `/` was answered with `{"error":"missing or invalid token"}` and the app
  never loaded. Static assets are now served to loopback without a token
  (`Host`/`Origin` are still enforced), while every `/api/*` request keeps
  requiring it.
- `gs init` now distinguishes "no key exists" from "keys exist but none was
  accepted". The second case is usually a permission or known-hosts problem, and
  the message now says so and points at `gs doctor --online` instead of asking
  for a key that is already there.
- **`gs doctor --online` reported a false authentication failure before the
  first `gs apply`.** It probed the generated host alias, which only exists once
  the managed block has been written, so ssh answered "Could not resolve
  hostname" and a perfectly good profile looked broken. The check now uses the
  alias only when it is actually defined in `~/.ssh/config`, otherwise it probes
  the real host with the key and user pinned explicitly.
- An unresolvable host is now reported as a warning with "could not be
  resolved", not as an authentication failure.
- Private key permissions are checked on **Windows** too. OpenSSH refuses keys
  readable by another principal ("Bad permissions. Try removing permissions for
  user: …"), which previously went undetected: the check only ran on POSIX. The
  ACL is inspected via `icacls`, with `Administrators`, `SYSTEM` and the current
  account correctly treated as expected, and a concrete `icacls` fix suggested.

### Security

- **The secret guard now catches credentials that previously slipped through.**
  `api_secret`, `github_token`, camelCase names like `myPassword`/`apiToken`, and
  values that are recognisably credentials — PGP private keys, `Bearer` tokens,
  JWTs, AWS access key ids, GitHub/GitLab/Slack tokens, `sk-` keys — are all
  refused. Previously only an exact `password`/`token`/`secret` key or an
  `-----BEGIN … PRIVATE KEY-----` value was caught, so pasting a token into a
  comment field stored it in a file meant to be shared.

### Changed

- **The repository in the About menu is now a link.** Clicking it opens the
  project page in a new tab. Only `http(s)` URLs become anchors — a `javascript:`
  or `file:` value in `package.json` stays inert text — and the anchor carries
  `rel="noopener noreferrer"` so the opened page cannot reach this window and the
  local URL (including the access token in its fragment) is not sent as a referrer.
- **The build tag moved from the header row into an “About” menu.** A string like
  `0.1.0+29.g4f3a3bf.dirty` is far too wide to sit beside the tabs, and it pushed
  them around. Version, author, licence, repository, commit and build time now
  live in a dropdown on the right; clicking elsewhere or pressing Escape closes
  it. Nothing about the report changed, only where it is shown.
- **All example data in the docs, tests and sample profiles is now generic.** The
  README, schema reference, `examples/`, test fixtures and code comments used a
  real name, a real work and personal email address, a real company Git host and
  a real directory layout. They now use `Alex Chen <alex@example.com>`,
  `git.company.example`, `~/code/…` and `10.0.0.10`, so nothing personal ships
  with the source.
- **Language follows the system by default, and unsupported languages fall back
  to English.** Previously `GS_LANG=ja-JP` produced *Chinese* output on a Chinese
  machine: the unknown tag was discarded and the OS language won by accident. A
  tag we recognise but do not translate (`ja`, `de-DE`, …) now resolves to
  English directly, while an empty or malformed tag still falls through to the
  next source.
- Traditional Chinese (`zh-TW`, `zh-HK`, `zh-Hant`) now resolves to English
  instead of being shown simplified Chinese, which those users did not ask for.
- On Windows the UI language comes from `(Get-UICulture)` rather than
  `Intl.DateTimeFormat()`, which follows the *regional format* setting; an
  English-display machine with a Chinese region is a common mismatch.
- **The tab bar now follows the setup dependency chain**: Keys → Identities →
  Rules → Preview. A key exists first, an identity uses it, a rule assigns a
  directory to that identity, and only then is there anything to apply.
- The Identities screen warns when no SSH key exists at all and offers a shortcut
  to the Keys screen, instead of letting a user create an identity that cannot
  route SSH. Creating a key now offers the reverse shortcut to Identities.
- **Forms on the identity and rule screens follow the order a user thinks in,
  and every control has a visible label.** Identity: *Basic identity* → *SSH
  key* → *Site*; a rule: *Target directory* → *Assign to an identity*. Labels
  stay visible while typing (placeholders alone disappear), required fields carry
  a `*`, and hints sit beside the label instead of inside the input.
- The SSH key is now a `<select>` of keys that actually exist in `~/.ssh` (plus a
  "no key" option) instead of free text, and the identity for a rule is a
  dropdown that starts on a placeholder rather than silently defaulting to the
  first entry.
- The directory browser fills the field and offers an explicit "Use this
  directory" button, instead of requiring the user to retype the path.
- A rules-screen section was reusing the identity screen's “Basic identity”
  wording; it now says “Assign to an identity”.

### Added

- **The GUI shows which build is running.** A version tag in the header mirrors
  `gs version` — version, author, licence, repository, commit and build time —
  served by a new `GET /api/version` endpoint. Clicking the tag expands the
  details; switching language re-renders them. This was the one capability the
  browser was missing: every other CLI command already had a screen.
- `npm run check:parity` audits CLI/GUI coverage: it reads the command dispatcher
  and the HTTP router and fails if a command gains no endpoint, a route has no
  screen, or the key actions drift apart between server and client.
- **`gs version` reports author, licence and repository, and every build names
  the commit that produced it.** The version carries SemVer build metadata —
  `0.1.0+27.gd5e0ebe`, meaning 27 commits at `d5e0ebe` — plus a `.dirty` suffix
  when the tree had uncommitted changes at build time. `scripts/build.mjs` writes
  `dist/build-info.json`; running from sources reports `0.1.0+dev` rather than
  pretending to be a release. `gs --version` and `gs version --short` keep
  printing the bare line so scripts stay unaffected; `--json` emits everything.
- The version is composed deterministically, so the same commit always produces
  the same string; the build timestamp lives in a separate `builtAt` field
  instead of the version.
- `gs add [dir] --identity <name>` binds a directory to an identity from the
  CLI.** Run it from the directory itself: `gs add . --identity work`. It accepts
  `.`, relative paths, `~` and absolute paths, and normalises them through the
  same function the GUI uses. Reassigning a directory that already belongs to
  another identity needs `--force`; an unknown identity name is rejected with the
  available names; a file is rejected as a target; a not-yet-existing directory
  is accepted with a warning so the layout can be planned ahead of a clone.
  `--dry-run` reports without writing and `--json` is supported.
- The GUI's rule editor and `gs add` now share one implementation
  (`core/rules.ts: upsertRule`), so the two cannot drift apart.
- **`resolveIdentity` now honours the documented "longest matching rule wins"**
  instead of returning the first rule in array order. Both schema references and
  the GUI promised specificity; array order was invisible to the user and made a
  nested rule silently lose to a parent one.
- **Every user-facing document now exists in both English and Simplified
  Chinese**, and each pair links to its counterpart: `README`, `CONTRIBUTING`,
  `SECURITY`, `docs/architecture` and `docs/profiles-schema`. The Chinese README
  had drifted far behind — it was missing the command table, the whole `gs gui`
  section, the `doctor` output sample and the technical-choices section.
- `npm run check:docs` keeps the pairs honest: same heading structure, same number
  of code blocks, real Chinese content rather than an English stub, and a working
  link in both directions.
- **An invalid profile can be repaired from the GUI.** Showing the error was not
  enough — the user opened a GUI to avoid editing YAML. The error banner now
  offers *Fix it for me*: the common mistakes (a URL pasted into `host`, a
  `host:port` pair, `git@host:owner/repo`) are split into `host` and `port`,
  previewed, and written only after confirmation. The original is kept as
  `profiles.yaml.before-repair`, and a repair that would still not parse is
  rejected instead of saved.
- **Renaming an SSH key.** The Keys screen can rename a key pair on disk; the
  `.pub` companion follows, and every identity or site that referenced the old
  name is rewritten so the profile keeps loading. An existing target, an invalid
  name and a missing source are all refused without touching anything.
- **Setting the global identity.** The overview screen can write `user.name` /
  `user.email` into `~/.gitconfig`. That identity lives *outside* the gs managed
  block, so it is edited directly rather than through `apply` — but only the two
  keys inside `[user]` change: comments, other sections and the managed block are
  preserved, and the previous value is reported back.
- **`gs list` and the GUI overview now name the global identity.** "No matching
  rule — falls back to the global identity" was not actionable without saying
  *which* identity that is; a personal repository committing with a work address
  is the exact failure this tool exists to prevent. The fallback identity is
  printed right under the warning and summarised on the overview screen, and an
  unset global identity is reported explicitly instead of staying silent.
- **Identities can be edited in the GUI**, not just added and deleted. Every
  field is editable — name, commit name/email, SSH key, and the site's
  host/port/alias — and renaming an identity updates every rule, repository
  override and site that refers to it, so the profile keeps loading. Invalid
  input is rejected without touching the file, and a rename onto an existing name
  is refused.
- **The GUI now covers every CLI command.** Three new tabs close the gap:
  - **Keys** — list keys with fingerprints and owning identities, copy a public
    key through the server-side clipboard, generate a new key pair (confirmed
    first), and restore keys from a snapshot. Private key material never reaches
    the browser.
  - **Migrate** — export a snapshot (optionally with keys, always encrypted) and
    import one with path remapping; a failed import leaves the profile untouched.
  - **Setup** — run `gs init` from the browser in two steps: *scan* reports what
    would be written, *save* persists it, and an existing profile is protected.
- A language picker in the header switches between English and Simplified Chinese
  immediately, re-fetching the catalogue and re-rendering the current screen.
- **Identity management in the GUI.** A new **Identities** tab lists every
  identity with its sites, adds one (name, commit name/email, SSH key, optional
  host/port/alias) and deletes one. The server validates the same rules the
  loader enforces — invalid email, bad name, duplicate name, out-of-range port —
  and persists only when the profile is valid, so the UI can never write a file
  that `gs apply` would refuse.
- Deleting is guarded: an identity still referenced by rules needs an explicit
  confirmation, and the **last** identity cannot be deleted at all (an empty
  identities map would make every `gs` command fail to load the profile).
- **Bilingual output (English / Simplified Chinese).** Every CLI message and every
  GUI label now comes from a catalogue. Language precedence is
  `--lang <en|zh-CN>` → `GS_LANG` → the OS locale → English. The GUI receives
  only its own `web.*` strings with `/api/state`, so one switch covers both
  surfaces. A missing translation falls back to English, then to the key, so a
  stale catalogue can never break the CLI.


- `gs key restore <snapshot> [--force]` — write the keys embedded by
  `snapshot export --with-keys` back into `~/.ssh`. Previously the export
  embedded key material and nothing could ever read it back: `--with-keys` was a
  one-way trip. Private keys are restored with mode `600`, existing files are
  kept unless `--force` is given, and `snapshot import` now points at this
  command instead of saying "restore them yourself".
- `npm run audit:coverage` — reports exported symbols the tests never reference.
  This is what surfaced the untested `list`/`diff`/`key`/`doctor`/`snapshot`
  command layer in round 19.
- Tests for `gs doctor`, `gs key` and `gs snapshot` (exit codes, `--json`
  output, overwrite refusal, round-tripped profiles) and for the secret guard
  (33 cases covering what must be blocked and what must still be allowed).
- Tests for `gs list`, `gs diff` and the diff renderer, which had none: the cwd
  resolution, the "no matching rule" warning, `--json` output for both commands,
  that `diff` never writes, and that apply-then-list agree.
- The GUI's ES modules are now **executed** in tests against a DOM shim, so a
  missing function or a wrong call signature fails a test instead of showing a
  blank page. Each of the four screens is rendered and asserted on, a failing API
  call is shown rather than thrown, and the token is verified to travel in the
  `x-gs-token` header. A deliberate mutation was used to confirm the tests catch
  regressions.
- GUI write-path tests: drive the real HTTP endpoints the browser calls
  (plan → apply → plan) and confirm with plain git that the identity took
  effect, that a malformed profile is refused without writing, and that a rule
  added in the UI reaches `~/.gitconfig`.
- `gs init` points at the identities most likely to need a personal address
  (`github`, `gitee`, …) when every identity received the global email, instead
  of a blanket “set a distinct email” hint.
- An end-to-end test builds a realistic code tree (`PDE-GIT`, `github`,
  `MyGithub`, `gitee`), applies, and asserts that plain git resolves a different
  identity per directory — the tool's core promise, verified through git itself.
- `gs init` now **probes which key actually authenticates each site**. A host that
  works through ssh's default key names (`id_ed25519` & co) previously looked
  keyless, so init reported a problem that did not exist. Candidates are tried in
  ssh's own preference order and the winner is written into the profile.
  `--offline` skips the network probes.
- Remote URLs are parsed into host/port/user, so a self-hosted server on a custom
  port (e.g. `ssh://git@git.example.com:9092/...`) is probed on that port instead
  of the default 22.
- Portability test suite covering `~` expansion, home contraction, `gitdir:`
  formatting, Windows-to-POSIX snapshot remapping, and posix path semantics
  verified in-process so the assertions also run on Windows. The `includeIf`
  output was additionally confirmed against a native Linux git.
- `gs key list` / `gs key gen` / `gs key copy` — list SSH keys with fingerprints
  and the identities using them, create an ed25519 pair (public key copied to the
  clipboard), and fetch a public key. Private key material is never written,
  copied or logged.
- `gs snapshot export` / `gs snapshot import` — portable snapshots for moving a
  setup to another machine. Keyless by default; `--with-keys` encrypts the whole
  archive with scrypt (N=16384) + AES-256-GCM. `--remap OLD=NEW` rewrites
  directory rules for a different layout, matching whole path segments only.
  Snapshots carry only the `gs`-managed SSH block, and each file is
  checksum-verified on import.
- `gs gui` — a local web UI bound to `127.0.0.1`, with four screens: Overview,
  directory Rules (with a server-side directory picker), Preview (the only
  screen that writes; always shows the plan diff first) and Diagnostics.
  Implemented as plain ES modules with no framework and no build step, served by
  the same zero-dependency process. Request security: per-process token,
  `Host` and `Origin` validation, no CORS headers, strict CSP, `no-store`.
  Includes single-instance locking and an idle shutdown (default 30 minutes).
- REST endpoints under `/api/`: `state`, `plan`, `apply`, `doctor`, `fs`,
  `rules`.
- `gs doctor` — diagnose the environment without touching it: missing or
  malformed SSH keys, keys referenced by an identity but never created, an
  absent `~/.ssh/config` managed block, aliases shadowed by the user's own
  `Host` entries, and the identity actually resolved for the current directory
  (read from `git config --show-origin`). Reports errors first and prints a
  runnable fix for each. `--online` adds real `ssh -T` handshakes.
- `gs apply` now warns when an identity references an SSH key that does not
  exist, instead of silently writing an unusable `IdentityFile`.
- `gs init` — discover SSH hosts and Git repositories, then write a starter
  `profiles.yaml`. Merges alternate SSH endpoints (`ssh.github.com`) onto their
  canonical host so one account does not produce two identities, and creates
  identities for remote hosts that are missing from `~/.ssh/config`.
- `gs list` — show identities, directory rules, and the rule that applies to the
  current directory.
- `gs diff` — preview every change `gs` would make, with a unified diff.
- `gs apply` — write managed blocks into `~/.gitconfig` and `~/.ssh/config`.
  Supports `--dry-run` and `--force`.
- Managed block engine: content outside `# >>> gs:managed >>>` markers is
  preserved byte-for-byte, including CRLF line endings.
- Declarative `profiles.yaml` (schema version 1) with identities, sites,
  directory rules and repository overrides.
- `site.sshHostName` — dial an alternate SSH endpoint (e.g. `ssh.github.com:443`)
  while keeping the real Git host for URL routing.
- `site.alsoRoutes` — route additional hostnames through one site's alias.
- Dependency-free YAML subset parser with precise error locations.
- Secret guard: `profiles.yaml` rejects passwords, tokens and private keys.
- Per-identity generated git configs with `insteadOf` URL routing covering
  `git@host:`, `https://host/` and `ssh://git@host` remotes.
- SSH `Host` aliases generated with `IdentitiesOnly yes`.
- Timestamped backups before every write; atomic writes.
- Concurrent-edit detection: refuses to overwrite files changed after planning.
- Warning when manual `includeIf` entries or conflicting `Host` entries exist
  outside the managed block.

### Changed

- Removed unreachable exports (`plannedBlockHash`, `readProfilesRaw`,
  `listSshKeys`, `renderProfileText`) that no caller used, found by the new
  coverage audit.

### Fixed

- **A truncated diff hid every added line.** A whole-file rewrite renders as all
  removals followed by all additions, so capping the output with a plain head
  slice showed only deletions — the user approved changes they never saw.
  Truncation now keeps removals and additions in balance and drops context lines
  first.
- `gs diff` wrote its diff bodies straight to `process.stdout`, bypassing the
  logger. Under `--json` that corrupted the JSON document (`Unexpected token
  'i'`), and the output could not be redirected or captured. Commands now write
  through `logger.write`.
- **The test suite was intermittently red.** `gui-command.test.ts` spawned the
  CLI as a child process while the test runner was writing to the same stdio
  channel, corrupting the runner's IPC stream on Windows
  (`Unable to deserialize cloned data`), which failed the whole file with no
  failing assertion. The command is now exercised in-process; five consecutive
  full runs are clean.
- **Sites without a key no longer produce a broken `Host` block.** A `Host` entry
  carrying `IdentitiesOnly yes` but no `IdentityFile` makes ssh fall back to its
  default keys (`id_rsa`, `id_ed25519`, …) — precisely the "wrong key is tried"
  problem gs exists to prevent. Such sites are now skipped, their `insteadOf`
  routing is omitted too (an alias with no Host block would not resolve), and
  `gs plan`/`gs diff` report each skipped site with the fix.
- **A Windows path is now recognised as absolute on every platform.** On Linux,
  `path.isAbsolute('D:\\code\\x')` is false, so a rule written on Windows was
  treated as a *relative* path and joined onto the current directory
  (`/app/D:/code/x`). Since snapshots move between machines, this corrupted
  migrated rules. Drive-letter and UNC paths are now detected independently of
  the host OS.
- **An installed package could not run at all.** `dist/` shipped TypeScript
  sources and relied on Node's runtime type stripping, which Node explicitly
  refuses inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`):
  every `gs` command failed with a stack trace after `npm install -g`. The build
  now compiles with `tsc` (`tsconfig.build.json`) and ships plain JavaScript;
  TypeScript stays a devDependency, so runtime dependencies remain zero.
- `gs gui` returned 500 from a built or installed package because the static
  asset lookup assumed the source layout. All three layouts (checkout, `dist/`,
  installed) are now resolved, with a clear error when none is present.
- Compiling for real surfaced three type errors that runtime stripping had
  hidden: a `promisify(scrypt)` overload losing the KDF options argument and an
  unguarded indexing in the YAML scalar parser. Both are fixed.
- **Packaging.** `dist/` now contains the GUI assets, so an installed package
  can serve `gs gui` (the tarball previously shipped only `dist/src`, making the
  web UI a 404). `npm run build` copies `web/` into `dist/web`, a `prepare` script
  builds automatically on install from a checkout, and asset lookup falls back
  across the development and published layouts with a clear error when neither
  is present.
- Write failures now name the file the user asked to write, not the internal
  `.gs-tmp` file used for the atomic swap, and explain the cause
  (`permission denied — is the file read-only?`, `no space left on device`,
  `filesystem is read-only`, `file is in use`). Temporary files are removed on
  every failure path.
- **Repeatable flags are honoured.** `gs snapshot import` used to keep only the
  last `--remap`, so migrating a machine with several separate code roots only
  rewrote one of them. Every occurrence is now applied in order; single-valued
  flags still take the last value.
- Backup files are now named `gitconfig.20261109-121222.bak` and
  `ssh-config.20261109-121222.bak` instead of encoding the entire absolute path
  with escaped separators, which made the origin of a backup impossible to read.
- `gs init` prints its “detected” section before its discovery warnings; the
  warnings used to appear above the heading they belonged to.
- Discovery warnings show `~/.ssh/config` rather than an absolute machine path.
- `gs list` shows the current directory with forward slashes, matching every
  other path in the output.
- Rule matching is now **case sensitive**, mirroring git's `gitdir:` behaviour.
  `gs` previously matched case-insensitively, so it would report an identity that
  git never actually applied (e.g. rule `/code/github` against a repository in
  `/code/GitHub`).
- Rule paths are aligned with the casing that exists on disk before generating
  `includeIf` entries, so a rule typed in the “wrong” case still works.
  `gitdir/i:` is not honoured by every git build, so normalising the path is the
  reliable fix.
- `gs doctor` now reports a repository that overrides its identity through a
  repository-local `user.email`. Such a value silently beats every directory
  rule, which is the usual reason a migrated repository still commits with the
  old identity.
- `gs doctor` now warns when a wildcard SSH block (`Host *`) pins `IdentityFile`.
  OpenSSH applies wildcard keys before host-specific ones, so the wrong key can
  be offered first even with `IdentitiesOnly yes`.
- `gs init` no longer drops repositories that sit **directly** under the scanned
  root (`code/myrepo`). They were skipped by the grouping step, so no rule was
  proposed for them and those repositories silently kept the global identity.
- The test runner now enforces a minimum test count. `node --test <glob>` exits
  0 with “tests 0” when the pattern matches nothing, which would have let CI go
  green without running a single test.
- `gs key gen` now creates `~/.ssh` when it does not exist; previously it failed
  with `ENOENT` on a fresh machine.
- `ssh://` remotes (typical for self-hosted servers with a custom port) are now
  routed through the identity alias instead of bypassing it.
- A custom port is no longer swallowed into the repository path: rewriting
  `ssh://git@host:9092/path` used to yield the broken `git@alias:9092/path`.
  Port-specific prefixes are now emitted ahead of the bare `ssh://git@host/`
  form, which git's longest-match rule requires.
- `gs init` no longer generates an alias that duplicates a `Host` name already
  present in `~/.ssh/config`; the fallback suffix is `-gs`.

## [0.1.0] - 2026-11-09

- Initial project scaffold.