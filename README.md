# gs — Git & SSH Identity Manager

[![npm version](https://img.shields.io/npm/v/@zhulij/git-switch?logo=npm&color=cb3837)](https://www.npmjs.com/package/@zhulij/git-switch)
[![install](https://img.shields.io/badge/install-npm%20i%20--g%20%40zhulij%2Fgit--switch-cb3837?logo=npm)](https://www.npmjs.com/package/@zhulij/git-switch)
[![Node](https://img.shields.io/badge/node-%3E%3D22.6-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-success)](package.json)

**Install and go:**

```bash
npm install -g @zhulij/git-switch
gs init
```

Manage **multiple Git accounts on one machine** without the usual mess.

If you push to GitHub with a personal key, to Gitee with another, and to a
corporate Gitea with a third — and your `~/.gitconfig` / `~/.ssh/config` keep
fighting each other — `gs` turns that into a **declarative, portable, auditable**
configuration.

[中文说明](README.zh-CN.md)

---

## Why

Multi-account Git setups usually break in three places:

| Symptom | Root cause | `gs` fix |
|---|---|---|
| `Permission denied (publickey)` on one host | SSH has no per-host `IdentityFile`, so it tries the wrong key | Managed SSH `Host` blocks, one per identity |
| Commits land with the wrong email | Global `user.email` leaks into every repo | Directory → identity rules via generated `includeIf` |
| Re-configuring a new laptop takes hours | Everything is scattered across files | Portable snapshot + one-command import |

---

## Features

- **Directory → identity mapping** — declarative rules, generated as `gitdir:` `includeIf` blocks
- **Managed config blocks** — writes only inside `# >>> gs:managed >>>` markers; the rest of your files stays byte-for-byte untouched
- **SSH key routing** — per-host `Host` aliases with `IdentitiesOnly yes`, so the wrong key is never offered
- **Safe by default** — atomic writes, timestamped backups, idempotent `apply`
- **Detects concurrent edits** — refuses to overwrite files changed after planning
- **Secrets never stored** — `profiles.yaml` validation rejects passwords, tokens and private keys
- **Zero runtime dependencies** — plain Node, no `node_modules`
- **Bilingual** — the CLI and the GUI both follow the system language (English / 简体中文)

---

## Quick Start

Install from npm — that is the way everyone else uses it:

```bash
npm install -g @zhulij/git-switch
gs init
```

Working on `gs` itself? Three ways to run a checkout — pick one:

```bash
# 1. from a checkout: Node runs the TypeScript sources directly (no build needed)
node src/cli.ts init

# 2. install the checkout globally (npm runs `prepare`, which compiles dist/)
npm install -g .
gs init

# 3. build once with the TypeScript compiler, then use the launcher
npm install && npm run build && node dist/gs.mjs init
```

> `dist/` holds **compiled JavaScript**, not TypeScript sources: Node refuses to
> strip types for files inside `node_modules`, so a package shipping `.ts` files
> would not run after installation. TypeScript is a devDependency only — the
> published package still has zero runtime dependencies.

`gs init` reads your machine and proposes a profile:

```
$ gs init
i detected
·   git identity   Alex Chen <alex@example.com>
·   ssh hosts      3
·   repositories   4
i proposed identities
·   github       Alex Chen <alex@example.com>  → ssh.github.com
·   company      Alex Chen <alex@example.com>  → git.example.com
·   gitee        Alex Chen <alex@example.com>  → gitee.com
i proposed rules
·   ~/code/github   →  github
·   ~/code/gitee    →  gitee
·   ~/code/company  →  company
! gitee.com: no SSH key associated yet; add sshKey to the identity in profiles.yaml
✓ wrote ~/.config/gs/profiles.yaml
· next: gs diff   (preview)   then   gs apply
```

Then edit `~/.config/gs/profiles.yaml` to taste and apply:

```bash
gs diff     # preview every change
gs apply    # write managed blocks, with backups
```

`gs` looks for its profile at `~/.config/gs/profiles.yaml`:

```yaml
schemaVersion: 1
identities:
  work:
    user:
      name: Alex Chen
      email: alex@company.example
    sshKey: id_ed25519
    sites:
      - host: git.company.example
        port: 9092
        alias: work
  personal:
    user:
      name: alexchen
      email: alex@personal.example
    sshKey: id_ed25519_github
    sites:
      - host: github.com
        port: 443
        sshHostName: ssh.github.com    # when the SSH endpoint differs from the host
        alias: gh

rules:
  - dir: ~/code/company
    identity: work
  - dir: ~/code/github
    identity: personal

settings:
  backupKeep: 20
```

> **About `sshHostName`**: `host` is the Git host that appears in
> `git@github.com:…`; `sshHostName` is the endpoint actually dialled. GitHub needs
> it to reach SSH through `ssh.github.com:443`. Swapping the two produces a
> connection that authenticates and then drops as soon as git asks for a pack.

Then:

```bash
gs diff     # preview every change
gs apply    # write managed blocks, with backups
```

---

## Commands

| Command | Purpose |
|---|---|
| `gs init [--root <dir>] [--force]` | Detect SSH hosts and repositories, write a starter profile |
| `gs list` | Show identities, directory rules and what applies here |
| `gs add [dir] --identity <name>` | Bind a directory (default: the current one) to an identity |
| `gs diff` | Preview every change `gs` would make |
| `gs apply [--dry-run] [--force]` | Write managed blocks to `~/.gitconfig` and `~/.ssh/config` |
| `gs doctor [--online]` | Diagnose keys, ssh config and the identity in this directory |
| `gs gui [--port N] [--no-open]` | Local web UI on `127.0.0.1` |
| `gs key list` | SSH keys with fingerprints and the identities using them |
| `gs key gen <name>` | Create an ed25519 key pair; public key goes to the clipboard |
| `gs key copy <name>` | Copy a public key to the clipboard |
| `gs key restore <snapshot> [--force]` | Write the keys from a snapshot back into `~/.ssh` |
| `gs snapshot export <file> [--with-keys] [--force]` | Write a portable snapshot |
| `gs snapshot import <file> [--remap OLD=NEW] [--force]` | Restore a profile on another machine |

Global options: `--home <dir>` (use an alternative home), `--json`, `--no-color`,
`--lang <en|zh-CN>`.

Exit codes: `0` ok · `1` warning · `2` error.

A usage mistake — an unknown or misspelled option (`--dryrun`), an option that
expects a value but is followed by another option, or an operand a command does
not take — is an error: exit `2`, with the option named. Unknown options are never
silently ignored, because `gs apply --dryrun` used to *apply* the change it was
supposed to preview. A malformed `--port` / `--idle-timeout` is a usage error too,
not a crash.

### Output, colour and `--json`

Colour is only used when stdout is a terminal. It is switched off automatically
when output is piped or redirected, and by `--no-color` or the
[`NO_COLOR`](https://no-color.org) environment variable (set it to any non-empty
value). `FORCE_COLOR` overrides the terminal detection. This keeps
`gs list | grep` free of escape sequences.

`--json` prints one machine-readable JSON document on stdout and nothing else
there — no banners, no progress lines, no ANSI. When a command fails, it exits
non-zero and, on paths that got as far as producing a result, still emits a
document describing the failure (`{"errors": [...]}`) rather than an empty stdout.
A run that failed before any result existed — a missing profile, a malformed
`profiles.yaml`, an unknown option — exits `2` and explains itself on stderr;
stdout is then empty, never a half-written fragment.

Errors print a single actionable line, not a stack trace. Set `GS_DEBUG=1` to add
the stack when reporting a bug.

### `gs version`

Every build carries the commit that produced it, so "which version is this?" has
a precise answer:

```
$ gs version
0.1.0+27.gd5e0ebe
· channel    release
· author     ziyang-coder
· license    MIT
· repo       https://github.com/ziyang-coder/git-switch
· commit     d5e0ebe
· built      2026-11-15T01:39:34.835Z
```

The suffix is SemVer **build metadata**: `0.1.0+27.gd5e0ebe` means 27 commits
after the start of history, at commit `d5e0ebe`. A `.dirty` suffix appears when
the tree had uncommitted changes at build time. The same commit always produces
the same string, so builds stay reproducible — the timestamp lives in `builtAt`,
not in the version.

For scripts, `gs --version` and `gs version --short` print that line alone;
`gs version --json` emits the whole structure. Running from a checkout instead of
a built package reports `0.1.0+dev`, which is honest about there having been no
build step.

The GUI shows the same report: a version tag in the header (click it for the
author, licence, repository and build time), served by `GET /api/version`.

### Binding the directory you are in

The most common edit is "this directory belongs to that account". Run it from
where you are standing:

```bash
cd ~/code/github/my-project
gs add . --identity personal     # added ~/code/github/my-project to identity personal
gs add . --identity work --force # reassign: needs --force because it belongs to someone else
gs add . --identity personal --dry-run   # report only
```

`gs` refuses to silently reassign a directory that already points at another
identity, and refuses an unknown identity name. The rule only takes effect after
`gs apply`.

### Migrating to another computer

```bash
# old machine
gs key list                          # check which keys each identity uses
gs snapshot export backup.gsnap --with-keys   # encrypted: keys included

# new machine
gs snapshot import backup.gsnap --remap ~/code=/home/me/code
gs doctor                            # confirms what is still missing
gs apply
```

Notes:

- Without `--with-keys` a snapshot holds **no key material at all**; keys are
  recreated per machine with `gs key gen` (safer: one key per machine).
- With `--with-keys` the whole snapshot is encrypted with scrypt + AES-256-GCM
  and a passphrase you choose (or `GS_PASSPHRASE`). A wrong passphrase fails
  loudly; nothing is written.
- Keys inside a snapshot are **never** written to `~/.ssh` automatically.
- `--remap` rewrites directory rules when the layout differs, matching whole path
  segments only (`~/code` does not touch `~/codex`).
- The snapshot carries only the `gs`-managed block of `~/.ssh/config`, never your
  own entries.

### `gs gui`

An eight-screen local web UI, ordered by the setup dependency chain: **Overview**
(identities, their sites, and the global identity — editable there), **Keys**
(list, copy, generate, rename, restore), **Identities** (add, edit, delete),
**Rules** (directory → identity matrix with a server-side directory picker),
**Preview** (the only screen that writes, always shows the diff first),
**Diagnostics** (the `gs doctor` checks with a re-run button), **Migrate**
(snapshot export/import) and **Setup** (first-run wizard).

```bash
gs gui          # prints http://127.0.0.1:<port>/#token=… and opens it
```

It is plain JavaScript with no build step and no framework, served by the same
zero-dependency Node process as the CLI. Security posture:

| Control | Why |
|---|---|
| binds `127.0.0.1` only | never reachable from the network |
| per-process random token | every request must carry `x-gs-token` |
| `Host` header validation | defeats DNS rebinding |
| `Origin` validation | rejects cross-site requests |
| no CORS headers | browsers cannot read our responses cross-origin |
| strict CSP + `no-store` | no inline script, no cached secrets |
| directory browse limited to allowed roots, `..` rejected | the picker cannot escape home |
| snapshot export/import paths confined to the home directory | a request cannot read or write elsewhere |
| profile writes serialised per home | two overlapping edits cannot lose one |

The GUI never writes without a plan: **Preview → show diff → confirm → apply**.

### What `gs doctor` catches

```
$ gs doctor
✗ ~/.ssh/id_ed25519_missing does not exist
·    referenced by work; git push/pull will fail with "no such identity"
·    fix: ssh-keygen -t ed25519 -C "<email>" -f "~/.ssh/id_ed25519_missing"
! work: no SSH key configured
✓ ~/.ssh/id_ed25519_github present
✓ ~/.ssh/config managed block present
✓ identity here: alex@personal.example
! connectivity not probed
·    pass --online to run real ssh handshakes
```

It reports errors first, never throws on a broken key, and prints a concrete
command for each fix. `--online` additionally performs real `ssh -T` handshakes.

---

## How It Works

`gs` never intercepts `git`. It is a **generator** — after `gs apply`, you use
plain `git` and `ssh` as usual.

```
profiles.yaml
      │
      │  gs apply
      ▼
~/.gitconfig                    (includeIf block)
~/.config/gs/identities/*.gitconfig
~/.ssh/config                   (Host block)
      │
      ▼
   git & ssh                    plain, unmodified
```

Generated `~/.gitconfig` block:

```ini
# >>> gs:managed >>>
[includeIf "gitdir:~/code/company/"]
	path = ~/.config/gs/identities/work.gitconfig
[includeIf "gitdir:~/code/github/"]
	path = ~/.config/gs/identities/personal.gitconfig
# <<< gs:managed <<<
```

> **Note:** `includeIf "gitdir:..."` only applies while git resolves a
> repository. Directories configured as rules must contain Git repositories for
> the mapping to take effect — which is exactly how you work.

> **The global identity:** a directory no rule matches falls back to
> `user.name` / `user.email` in `~/.gitconfig`. That value is **not** inside the
> managed block, so `gs list` and the overview screen always name it — a personal
> repository committing with a work address is the exact failure this tool exists
> to prevent.

---

## Safety Model

| Property | Guarantee |
|---|---|
| Foreign content | Preserved byte-for-byte, including CRLF line endings |
| Backups | Every write is preceded by a timestamped backup |
| Idempotency | A second `apply` with no config change writes nothing |
| Concurrency | Refuses to write files changed after planning (`--force` overrides) |
| Hand edits | A line inside a managed block that `gs` did not generate blocks `apply`; `--force` overwrites it |
| Unreadable targets | One unreadable file becomes a per-file error; the other files still plan and apply |
| Markers | Duplicate or orphaned markers abort instead of guessing |
| Secrets | `profiles.yaml` may never contain passwords, tokens or private keys |
| Malformed config | Rejected with a line number or field path, never silently ignored; the UI stays usable and can repair common mistakes in one click |
| Write failures | Reported per file with the real target name and cause; the other files still apply; no temp files leak |
| GUI writes | Identity/rule/snapshot edits only touch `profiles.yaml`; a confirmed Preview is required before anything reaches your system config |

---

## Technical choices

| Choice | Reason |
|---|---|
| Zero runtime dependencies | portable: the published package has no install tree |
| Native TypeScript via Node ≥22.6 type stripping | no build step while developing |
| `tsc` for the published build | Node forbids type stripping inside `node_modules` |
| Hand-written YAML subset | `profiles.yaml` needs a documented subset, not a full parser |
| Plain JS + Web Components for the GUI | no bundler, no framework, ~30 KB of source |
| Generator, not a `git` wrapper | after `gs apply`, plain `git` just works |
| One message catalogue for both surfaces | the CLI and the GUI cannot drift apart; a missing entry falls back to English |

---

## Requirements

- Node.js ≥ 22.6 (native TypeScript type stripping)
- Git 2.36+

Runs on Windows, macOS, and Linux.

---

## Development

```bash
npm install           # devDependencies only (typescript, @types/node)
npm test              # unit + end-to-end tests
npm run typecheck     # tsc --noEmit
npm run build         # compile to dist/ for publishing
```

Every test runs against a **throw-away home directory**; the developer's real
`~/.gitconfig` and `~/.ssh/config` are never touched.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.

---

## Roadmap

- [x] M1 — managed blocks, `init` / `apply` / `diff` / `list`
- [x] M2 — `doctor` diagnostics (keys, ssh config, identity resolution)
- [x] M3 — `gs gui` (local web UI, zero dependencies)
- [x] M4 — SSH key management, encrypted snapshots, `export` / `import`
- [x] M5 — GUI parity with the CLI, bilingual output, self-healing config errors

---

## License

MIT
