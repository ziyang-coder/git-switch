# Publishing to npm

[中文说明](publishing.zh-CN.md)

How a release is made. Publishing is **irreversible**: a version that reaches the
registry can never be reused, and its tarball cannot be removed (only
`npm deprecate`d).

---

## 1. One-time setup

### Create an npm account

<https://www.npmjs.com/signup>

To publish as `@zhulij/git-switch`, **your npm username must be `zhulij`** — the scope belongs to that account.

### Log in — watch the registry

```bash
npm login --registry https://registry.npmjs.org/
```

> ⚠️ This machine defaults to the Taobao mirror (`registry.npmmirror.com`), which is
> **read-only for publishing**. The `--registry` flag is not optional.
>
> To switch permanently: `npm config set registry https://registry.npmjs.org/`

Confirm:

```bash
npm whoami --registry https://registry.npmjs.org/
```

### Check the name is free

```bash
npm view @zhulij/git-switch version --registry https://registry.npmjs.org/
```

`404` means it is available; a version number means the package already exists.

---

## 2. Release steps

### Clean tree

```bash
git status --short     # must be empty
npm test               # must be 0 failures
```

**Do not publish from a dirty tree** — `dist/build-info.json` records `.dirty`, and
the version users install then corresponds to no commit in the repository.

### Build

```bash
npm run build
```

Produces `dist/` (compiled JavaScript, GUI assets and `build-info.json`).

### Pre-publish checks

```bash
npm run prepublish:verify
```

Thirty checks covering the package identity, the absence of runtime dependencies,
that `dist/` is complete and free of `.ts` sources, that the tarball excludes
`src/`, `test/` and personal paths — and it **installs the tarball into a
throw-away prefix and runs `gs version`**.

Only when everything passes:

```
ready to publish @zhulij/git-switch@0.1.0
```

### Inspect the tarball

```bash
npm pack
tar -tzf zhulij-git-switch-0.1.0.tgz | head -20
```

### Publish

```bash
npm publish --registry https://registry.npmjs.org/
```

`package.json` already sets `publishConfig.access=public`, so the scoped package is
published publicly without an extra flag.

### Verify

```bash
npm view @zhulij/git-switch --registry https://registry.npmjs.org/

npm install -g @zhulij/git-switch --registry https://registry.npmjs.org/
gs version
```

---

## 3. Later releases

```bash
npm version patch   # 0.1.0 -> 0.1.1  (bug fix)
npm version minor   # 0.1.0 -> 0.2.0  (new feature)
npm version major   # 0.1.0 -> 1.0.0  (breaking change)

git push --follow-tags
npm publish --registry https://registry.npmjs.org/
```

### Version semantics

| Phase | Version | Meaning |
|---|---|---|
| Pre-stable | `0.x.y` | API may change; `^0.1.0` matches only `0.1.x` |
| Stable | `1.0.0` | Backwards compatibility promised |

### Pre-releases

```bash
npm version 0.2.0-beta.1
npm publish --tag beta --registry https://registry.npmjs.org/
```

`--tag beta` keeps it off `latest`; users opt in with `@beta`.

---

## 4. When something goes wrong

| Situation | Action |
|---|---|
| Bug found right after publishing | Fix, `npm version patch`, publish again. **Never try to delete** |
| A version is unsafe | `npm deprecate @zhulij/git-switch@"<0.1.3" "security fix in 0.1.3"` |
| Wrong files shipped | Fix `files` for the next release; the published one cannot be recalled |
| A secret leaked | Rotate the secret now, then `npm unpublish --force` (only within 24h) |

---

## 5. Never do this

- ❌ `npm publish` against a mirror registry
- ❌ `npm publish --force` to skip checks
- ❌ Reuse a published version number (npm refuses anyway)
- ❌ Publish from a dirty working tree
- ❌ Commit an `NPM_TOKEN`

---

## 6. About the name

`git-switch` is **already taken** on npm (v1.1.0), so this project publishes as the
scoped package `@zhulij/git-switch`.

A scope guarantees the namespace is yours — nobody can register a confusingly
similar name. The cost is a longer install command:

```bash
npm install -g @zhulij/git-switch
```

The command itself is still `gs`.
