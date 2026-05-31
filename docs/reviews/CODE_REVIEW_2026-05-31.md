# @meta-agent/runtime 全面代码评审

**日期**: 2026-05-31
**版本**: 0.2.1
**规模**: src 下 288 个 TS 文件、约 39.8k 行代码、45 个测试文件
**基线**: `tsc --noEmit` 通过；`vitest run` 全部通过(45 文件 / 338 用例)

评审覆盖四个维度:安全与权限、架构与设计、正确性与健壮性、测试与质量。结论先行:**核心运行时(kernel 循环、权限策略、SSRF 过滤、原子写、dispose 生命周期)工程质量相当高,测试纪律好。主要风险集中在三类:(1) 几处安全防护是"尽力而为"的启发式,存在可绕过/竞态窗口;(2) 持久化层原子写纪律不统一;(3) 仓库卫生严重失控(node_modules 与 dist 被提交)。**

---

## 一、按优先级汇总

| 级别 | 编号 | 问题 | 维度 |
| --- | --- | --- | --- |
| 🔴 高 | H1 | `web_fetch` SSRF 校验存在 DNS rebinding 竞态窗口 | 安全 |
| 🔴 高 | H2 | 仓库提交了 `node_modules`(4877 文件)且无 `.gitignore` | 质量 |
| 🟠 中 | M1 | 主 agent 的 `bash` 默认不进沙箱,命令内路径校验靠启发式可绕过 | 安全 |
| 🟠 中 | M2 | `TeamStore` 乐观并发检查本身是 TOCTOU,跨进程会丢更新 | 正确性 |
| 🟠 中 | M3 | 持久化原子写纪律不统一:多个 store 直接 `writeFile`,易在崩溃时损坏 | 正确性 |
| 🟠 中 | M4 | 构建产物 `dist/`(973 文件)入库,易与源码漂移 | 质量 |
| 🟡 低 | L1 | `readJsonFile`/store `read()` 把"损坏"与"不存在"都吞成 `null` | 正确性 |
| 🟡 低 | L2 | `package.json` 自引用依赖 `"@meta-agent/runtime": "file:"` | 质量 |
| 🟡 低 | L3 | `web_fetch` 缓存声称 LRU 实则 FIFO;无 fsync 的原子写有持久化盲区 | 正确性 |
| 🟡 低 | L4 | 敏感命令检测可被简单变形绕过(纵深防御层,非主防线) | 安全 |
| 🟡 低 | L5 | 无进度检测仅在助手文本为空时触发 | 正确性 |

---

## 二、安全与权限

### 🔴 H1 — `web_fetch` 的 SSRF 防护存在 DNS rebinding 竞态

`src/tools/network/web_fetch/index.ts` 的 SSRF 设计整体优秀:拒绝非 http(s)、显式拒绝 `localhost`、对 IPv4/IPv6 私网/回环/链路本地/云元数据(169.254.169.254)分类拦截,并且**手动逐跳跟随重定向**,每跳都重新校验——这点比绝大多数实现都更严谨。

但存在一个经典的 **TOCTOU / DNS rebinding** 缺口:`validateUrl()` 通过 `dns.lookup(host)` 解析并检查 IP(检查时刻 T1),随后 `fetchWithSafeRedirects` 调用 `fetch(check.value.url, …)`,而 `fetch` 内部会**对 hostname 再做一次独立的 DNS 解析**(使用时刻 T2)。攻击者控制的 DNS 可以在 T1 返回公网 IP、在 T2 返回 `169.254.169.254` 或 `127.0.0.1`,从而绕过全部分类检查访问内网/元数据服务。

> 代码里的注释("a 302 from a public host to 169.254.169.254 cannot bypass the check")只覆盖了**重定向**这条路径,没有覆盖**同一 hostname 的二次解析**。

**修复方向**:校验后把请求**钉死到已解析的 IP**——用自定义 `lookup`/`Agent`,或直接以 IP 发起请求并手动设置 `Host` 头(同时注意 TLS SNI/证书校验)。否则当前防护可被绕过。

### 🟠 M1 — 主 agent 的 bash 不进沙箱;命令内路径校验是启发式

两点叠加值得关注:

1. `src/tools/shell/bash/index.ts` 注释明确写着 *"main agent bash runs unsandboxed for now"*,`permission.sandbox` 留空。也就是说主 agent 的 shell 命令在宿主机直接执行,真正的隔离边界(`LinuxSandboxExecutor`/bwrap)只对子 agent 生效。
2. bash 工具自身只校验 `cwd` 是否在工作区内,**不检查命令字符串里引用的路径**。命令内绝对路径的拦截完全依赖 `PermissionPolicy.findWorkspaceViolation` 里的正则启发式 `looksLikeFilesystemPath`,而它只在首段命中 `KNOWN_OS_ROOT_DIRS` 白名单时才拦截。

因此诸如 `cat ~/.ssh/id_rsa`(`~` 由 shell 展开,正则要求前导 `/` 故不匹配)、`cat $(echo /etc/passwd)`、相对路径穿越 `../../etc/...` 等都能绕过工作区边界。**这本质上是纵深防御层而非硬边界**;真正的边界应当是沙箱。建议:为主 agent 也接入沙箱执行,或在文档中明确"工作区限制对 bash 是 best-effort,真正隔离需启用沙箱"。

值得肯定的是 env 默认走 `filtered` 策略,系统性剥离 `*_API_KEY/_TOKEN/_SECRET` 及显式黑名单,有效防止通过 shell 回显 API key——这块做得好。

### 🟡 L4 — 敏感命令检测可被变形绕过

`SensitiveCommandPatterns.ts` 覆盖面广(rm/git push/sudo/curl|sh/chmod 777 等)。但基于正则的命令分类天然可被绕过:`r""m -rf`、`$(echo rm) -rf`、base64 解码后执行、变量拼接等。这是纵深防御的合理一环,但**不应被当作可靠的安全边界**——建议在文档中如实标注其定位。

### 路径守卫(正面)

`workspaceGuard.ts` 与 `PermissionPolicy` 里的 `resolveForPolicy` 都正确处理了**不存在路径**的情况(回溯到最近存在的祖先做 `realpathSync`,再拼回相对部分),能防住符号链接逃逸,实现得相当扎实。唯一遗留是经典的 TOCTOU(校验后、使用前路径被替换为符号链接),以及 macOS 大小写不敏感文件系统下的前缀比较——属于已知的固有限制,可记录但优先级低。

---

## 三、架构与设计

整体分层清晰、职责单一,是这份代码最强的部分:

- **kernel/** 把流式调用、工具循环、compact、权限、成本统计封装成与上层无关的内核;`KernelLoop` 是一个干净的 `while(true)` 状态机,step 编号与设计文档对应,fallback/compact/token 升级/no-progress 等边界都有显式分支。
- **core → modes → routing** 的分层合理:`SessionRouter` 按模式分发,`MetaAgentSession`/`CampaignSession`/`RoboticsSession` 各司其职,`dispose` 生命周期有专门测试(idempotent、清空 messages/fileCache/tools)。
- **持久化抽象**集中在 `core/persist`,单点实现原子写,设计意图正确(见下文 M3 关于落地不一致)。
- **工具系统**用统一的 `MetaAgentTool` 接口 + `instrumentTool`(V&V + provenance 包装),扩展性好。

可改进点(设计层面,非缺陷):

- `isInsideWorkspace` 这段"判断路径是否在工作区内"的逻辑在 `workspaceGuard.ts`、`PermissionPolicy.ts`、`bash/index.ts` 里**各实现了一份**(语义略有差异:bash 版没有 `findExistingAncestor` 回溯)。安全关键逻辑重复实现是隐患,应统一到一个导出函数,消除行为漂移。
- `web_fetch` 的缓存是**模块级单例 `Map`**。在库被多次实例化/多租户场景下会跨会话共享缓存,且无法按会话清理(只有全局 `clearWebFetchCache`)。

---

## 四、正确性与健壮性

### 🟠 M2 — `TeamStore` 乐观并发是 TOCTOU,跨进程丢更新

`writeAll(state, checkUpdatedAt)` 的"读盘 → 比对 updatedAt → 原子写"流程:`atomicWriteJson` 只保证**单文件不被写花**,不保证**比对到写入之间无人插入**。两个进程(team 模式本就是多 unit 协作)可能都读到相同 `updatedAt`、都通过检查、先后 rename,**后者静默覆盖前者**(lost update)。文件头注释也承认"conflicts are rare and retry is cheap",但当前实现并没有真正的锁,只是缩小了窗口。

对一个明确面向"多人/多 agent 共享 lab notebook"的特性,这是真实风险。若要正确,需要文件锁(`flock`/`O_EXCL` lockfile)或基于 git 的真正合并(代码里已有冲突检测/`--theirs` 解决的脚手架,可考虑统一走 git 事务)。

### 🟠 M3 — 原子写纪律不统一

`core/persist` 提供了正确的 `atomicWriteJson`/`atomicWriteFile`(随机后缀 + write-then-rename),`ProvenanceTracker`、`campaign/store`、`TeamStore` 等都正确使用。但仍有多处**直接 `writeFile` 到目标路径**,崩溃/并发时会留下半截损坏文件:

- `src/robotics/ExperiencePendingStore.ts:183`、`PhysicalAnchorPendingStore.ts:121`、`PrinciplePendingStore.ts:135`、`ExperienceStore.ts:182`
- `src/core/memory/memoryWriter.ts:333`
- `src/core/compact/stateSnapshot.ts:214`、`runStateSnapshot.ts:181`

此外 `MetaAgentContextStore.ts:97` 用的是**固定 `.tmp` 后缀**(`ACTIVE_CONTEXT_FILE + '.tmp'`),与 `core/persist` 的随机后缀不同——两个并发写者会争用同一个 `.tmp`,反而引入新竞态。建议:所有持久化状态统一走 `core/persist` 的 helper,删除各处手写的写盘逻辑。

### 🟡 L1 — "损坏"与"不存在"被吞成同一种 null

`readJsonFile`(persist)和各 store 的 `read()`(如 `TeamStore.read`)在 `JSON.parse` 失败时直接 `return null`,与"文件不存在"无法区分。结果是:一个被写花/被外部破坏的状态文件,会被静默当成"全新/空状态"处理,可能**悄无声息地丢掉用户的全部任务/经验记录**。建议至少在解析失败时记日志或保留 `.corrupt` 备份,而非静默归零。

### 🟡 L3 — 缓存语义与持久化细节

- `web_fetch` 缓存超出 `CACHE_MAX` 时按"插入最旧"驱逐(依赖 Map 插入序),命中时不会重新插入——所以是 **FIFO 不是 LRU**,与注释/直觉不符。影响小,但语义应说清。
- `atomicWriteJson` 在 `rename` 前没有 `fsync`,极端断电场景下 rename 可能指向尚未落盘的内容(持久化盲区)。对当前用途多半可接受,记录备查。

### 🟡 L5 — no-progress 检测的触发条件偏窄

`KernelLoop` 的"重复同一工具调用 3 次"保护仅在 `assistantText.trim().length === 0` 时计数。若模型每轮都附带一点文本却反复发起相同工具调用,该保护不会触发,可能空转到 `maxTurns`。可考虑放宽为"工具签名相同即计数"。

### 正面

- `dispose` 幂等、`_permissionDenials` 有上限(S16)、compact LRU、ContextPager TTL/预算驱逐等都**有针对性单测**,边界意识强。
- 错误处理整体克制:全仓 `console.log`(非 cli)为 0、空 `catch {}` 为 0、`TODO/FIXME` 为 0、`as any` 仅 19 处。
- bash 超时/maxBuffer/abortSignal/超时后回显已捕获输出(M9)等处理细致。

---

## 五、测试与质量

### 正面

- 338 个用例全绿、`typecheck` 干净;测试聚焦在并发(`TeamStore.concurrent/exclusivity/fetchCooldown`)、生命周期(dispose)、缓存驱逐、schema 校验、SSRF 等**真正容易出错的地方**,而非凑覆盖率。
- 测试与回归编号(S1/S5/S16/H4/M3…)挂钩,说明缺陷修复有意识地补了回归测试。

### 🔴 H2 — 仓库提交了 node_modules,且没有 .gitignore

仓库**没有 `.gitignore`**,`git ls-files node_modules` 显示有 **4877 个文件**被纳入版本控制(含 `.bin` 软链)。这会:极大膨胀仓库、让 clone/diff 缓慢、把依赖的平台相关二进制固化进历史、并导致 `git status` 出现 `node_modules/nanoid/.claude/` 这类噪声。**应立即添加 `.gitignore`(至少 `node_modules/`、`*.tgz`、`dist/`)并从索引移除**(`git rm -r --cached node_modules`)。

### 🟠 M4 — dist 构建产物入库

`dist/`(973 个 `.js/.d.ts/.map`)被提交。配合 `.npmignore` 排除 `src/`、`package.json` 的 `files: ["dist"]`,说明发布走 dist——但**构建产物入库**意味着它可能与 `src` 漂移(评审时实测 dist 比 src 新约 30s,当前一致,但靠人工保证)。建议:dist 加入 `.gitignore`,改由 `prepublishOnly`/CI 构建产出,源码与产物解耦。另:根目录还提交了两个 tarball(`*-0.1.0.tgz` 5.3MB、`*-0.2.1.tgz` 1.1MB),应一并清理。

### 🟡 L2 — package.json 自引用依赖

`dependencies` 里有 `"@meta-agent/runtime": "file:"`,在 `node_modules/@meta-agent/runtime` 形成指向仓库根的软链(自指)。这通常是为了让内部代码用包名 `@meta-agent/runtime` 自导入,但属于易混淆的反模式,且会让发布到 npm 的 `dependencies` 出现自引用。建议改用相对路径导入或 tsconfig path 别名,从依赖里移除自引用。

---

## 六、结论与建议处置顺序

这是一份**核心工程质量明显高于平均水平**的代码库:kernel 循环、权限模型、SSRF 设计、原子写抽象、dispose 生命周期、测试纪律都体现了成熟的工程判断。要解决的不是"烂代码",而是几个**边界严谨性**和**仓库工程化**的缺口。

建议按此顺序处理:

1. **立刻(质量止血)**:加 `.gitignore`,`git rm -r --cached node_modules dist *.tgz`,清理仓库(H2/M4)。
2. **本周(安全)**:修 `web_fetch` 的 DNS rebinding(钉死已解析 IP)(H1);明确 bash 沙箱定位,统一三处 `isInsideWorkspace`(M1)。
3. **迭代(健壮性)**:把所有状态持久化统一到 `core/persist` 原子写、修 `MetaAgentContextStore` 的固定 `.tmp`(M3);给 `TeamStore` 加真正的锁或走 git 事务(M2);解析失败不再静默归零(L1)。
4. **清理**:移除自引用依赖(L2),修正缓存 LRU 语义说明、放宽 no-progress 触发(L3/L5)。
