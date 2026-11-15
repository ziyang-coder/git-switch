# 发布到 npm

[English](publishing.md)

本文档记录 `gs` 的发布流程。发布是不可逆的：一旦某个版本出现在 registry 上，
**同一个版本号永远不能再次使用**，且 tarball 无法删除（只能 `npm deprecate` 标记废弃）。

---

## 一、发布前准备（只需做一次）

### 1. 注册 npm 账号

<https://www.npmjs.com/signup>

如果你打算用作用域包 `@zhulij/git-switch`，**npm 用户名必须是 `zhulij`**，
否则这个作用域不归你。

### 2. 登录（注意 registry）

```powershell
npm login --registry https://registry.npmjs.org/
```

> ⚠️ 本机默认 registry 是淘宝镜像 `registry.npmmirror.com`，**镜像只读，不能发布**。
> 上面的 `--registry` 参数不能省。
>
> 也可以临时切换：`npm config set registry https://registry.npmjs.org/`（发完可改回）

验证登录状态：

```powershell
npm whoami --registry https://registry.npmjs.org/
```

### 3. 确认包名可用

```powershell
npm view @zhulij/git-switch version --registry https://registry.npmjs.org/
```

- 输出 `404` → 可用
- 输出某个版本号 → 已存在这个包，需要换名

---

## 二、发布流程

### 1. 确保工作区干净

```powershell
git status --short          # 应为空
npm test                    # 必须 0 失败
```

**不要在未提交的状态下发布**——`dist/build-info.json` 会记录 `.dirty`，别人装到的版本
无法对应到仓库里的任何提交。

### 2. 构建

```powershell
npm run build
```

会生成 `dist/`（编译后的 JavaScript + GUI 资源 + `build-info.json`）。

### 3. 发布前校验

```powershell
npm run prepublish:verify
```

这一步会检查 30 项，包括：

- 包名合法、作用域公开、registry 指向官方
- 零运行时依赖、有 licence / repository / engines
- `dist/` 完整且不含 `.ts` 源码
- tarball 不含 `src/`、`test/`、个人路径
- **把 tarball 装到临时目录并真的运行 `gs version`**

全部通过才会打印：

```
ready to publish @zhulij/git-switch@0.1.0
```

### 4. 本地再确认一次

```powershell
npm pack                          # 生成 .tgz
tar -tzf zhulij-git-switch-0.1.0.tgz | Select-Object -First 20
```

### 5. 发布

```powershell
npm publish --registry https://registry.npmjs.org/
```

`package.json` 里已设置 `publishConfig.access=public`，作用域包会正确地公开，
不需要额外加 `--access public`（加了也无害）。

### 6. 验证

```powershell
# 等几秒让 CDN 同步
npm view @zhulij/git-switch --registry https://registry.npmjs.org/

# 装一遍真正的产物
npm install -g @zhulij/git-switch --registry https://registry.npmjs.org/
gs version
```

---

## 三、后续版本

### 改版本号

```powershell
# npm version 会自动提交并打 tag
npm version patch   # 0.1.0 -> 0.1.1  （修 bug）
npm version minor   # 0.1.0 -> 0.2.0  （加功能）
npm version major   # 0.1.0 -> 1.0.0  （破坏性变更）

git push --follow-tags
npm publish --registry https://registry.npmjs.org/
```

### 版本号语义

| 阶段 | 版本 | 含义 |
|---|---|---|
| 开发中 | `0.x.y` | API 可能变，`npm` 的 `^0.1.0` 只匹配 `0.1.x` |
| 正式 | `1.0.0` | 承诺向后兼容 |

### 预发布版

```powershell
npm version 0.2.0-beta.1
npm publish --tag beta --registry https://registry.npmjs.org/
```

`--tag beta` 让它不占用 `latest`，用户需显式 `npm i -g @zhulij/git-switch@beta`。

---

## 四、出问题了怎么办

| 情况 | 处理 |
|---|---|
| 刚发就发现严重 bug | 立刻修 → `npm version patch` → 重新发。**不要试图删除** |
| 某个版本有安全问题 | `npm deprecate @zhulij/git-switch@"<0.1.3" "security fix in 0.1.3"` |
| 误发了不该发的文件 | 下次发布时修 `files` 字段；已发布的无法撤回 |
| 发现泄露了密钥 | 立即轮换密钥，然后 `npm unpublish --force`（24 小时内可删，之后只能 `deprecate`） |

---

## 五、不要做的事

- ❌ 在镜像 registry 上 `npm publish`
- ❌ 用 `npm publish --force` 跳过检查
- ❌ 重复使用已发布过的版本号（npm 会直接拒绝）
- ❌ 在 `dirty` 工作区发布
- ❌ 把 `NPM_TOKEN` 提交进制仓库

---

## 六、包名说明

`git-switch` 在 npm 上**已被他人占用**（v1.1.0），因此本项目发布为作用域包
`@zhulij/git-switch`。

作用域包的好处是命名空间归你所有，不会有人抢注同名包造成混淆。
代价是安装命令稍长：

```bash
npm install -g @zhulij/git-switch
```

安装后命令仍是 `gs`，没有变化。
