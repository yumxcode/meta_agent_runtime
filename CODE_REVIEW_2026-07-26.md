# meta-agent-runtime 代码评审报告

**评审日期**：2026-07-26
**版本**：0.7.9（`package.json`）
**评审范围**：`src/`（554 个 `.ts` 文件，约 96k 行）
**评审策略**：核心运行时（core / kernel / permissions / sandbox / subagent / loop-graph / persist / jobs / tools）逐文件深读；robotics / campaign / cli / infra 等外围模块按缺陷模式扫描。
**运行环境**：源码从设备快照拉入云端只读分析，未执行 `tsc` / 测试。

---

## 总体评价

这是一份**成熟度明显高于一般 agent 框架**的代码库。它对分布式/并发系统里最容易出问题的地方——崩溃恢复、跨进程锁、乐观并发、TOCTOU、SSRF、幂等提交——都有针对性设计，而且很多修复点在注释里标注了历史编号（M1/H1/L2/P1-9 …），说明经过多轮加固。事件溯源的 loop/graph 运行时（`CommitCoordinator` + `GraphStore`）、`web_fetch` 的 DNS 钉扎防 SSRF、`withFileLock` 的 owner-token 防误删、`SessionStore` 的 index→history 锁序，都属于**正确且深思熟虑**的实现。

下面按严重级别列出发现。需要强调：绝大多数"边界条件"这份代码都已经处理，因此本报告聚焦于**仍然存在的真实缺陷**与**值得记录的设计取舍**，而非罗列已被覆盖的场景。

---

## P0 — 阻断级

无。

---

## P1 — 高（应尽快修复）

### P1-1 `package.json` 存在指向自身的循环依赖，会破坏已发布包的安装

**文件**：`package.json:47`

```json
"dependencies": {
  "@anthropic-ai/sdk": "^0.54.0",
  "@meta-agent/runtime": "file:meta-agent-runtime-0.7.9.tgz",   // ← 依赖自己
  "openai": "^6.39.0",
  "zod": "^4.4.3"
}
```

这个包（`name` 就是 `@meta-agent/runtime`，见 `package.json:2`）把**自己的本地 tarball 声明成了运行时依赖**。问题在于：

- `files` 字段只发布 `dist`（`package.json:17-22`），`meta-agent-runtime-0.7.9.tgz` 不会随包发布；
- 因此任何用户执行 `npm install @meta-agent/runtime` 时，npm 会尝试解析一个 `file:meta-agent-runtime-0.7.9.tgz`——该文件在用户机器上不存在，安装报错或产生一个自引用的循环解析。
- 即使在本仓库内 `npm install`，这也是一个语义错误的自引用（包不应把自己列为 dependency）。

**影响**：README 主打"既是 npm 库也是 CLI"，但按现状发布后 `npm i` 大概率失败。这是发布流程里最优先要修的问题。

**建议**：从 `dependencies` 中删除 `@meta-agent/runtime` 这一行。它看起来是某次 `npm pack` + 本地联调残留下来的。修复后用 `npm pack` 在干净目录里做一次真实安装验证。

---

## P2 — 中（安全纵深 / 正确性取舍）

### P2-1 OS 沙箱对"读"没有默认约束，与"OS 沙箱才是真正边界"的注释存在落差

**文件**：`src/sandbox/profiles/macos.ts:79-84`、`src/sandbox/profiles/bwrap.ts:50`、`src/tools/shell/bash/index.ts:147`、`src/kernel/permissions/PermissionPolicy.ts:406-416`

沙箱 profile 的实际策略是"**只拦写、不拦读**"：

- macOS：`(allow default)` 之后仅 `(deny file-write*)`（`macos.ts:79,84`）。默认允许一切，读操作完全放行。
- Linux：`--ro-bind / /`（`bwrap.ts:50`）把整个主机文件系统以**只读但可读**的方式挂进沙箱。
- 默认主沙箱 `DEFAULT_MAIN_SANDBOX = { allowUnsandboxedFallback: true }`（`bash/index.ts:147`），`readDenyPaths` 默认空、`network` 默认 `unrestricted`（`sandbox/types.ts:63`）。

然而 `PermissionPolicy.ts:411-415` 的注释写道："*the real boundary is the fail-closed OS sandbox below*"，并在 auto 模式对通过路径检查的敏感命令**免确认自动放行**（`autoApproveInWorkspace`，`PermissionPolicy.ts:416`）。

这里的不对称是关键：
- 对**写**：既有 best-effort 的正则路径守卫（`findWorkspaceViolation` / `findBashRelativeEscape`），又有 OS 沙箱把工作区外的写真正 fail-closed。**双层纵深**。
- 对**读**：唯一的边界是那道**代码自己承认可被绕过**的正则守卫（`SensitiveCommandPatterns.ts:5-9`、`PermissionPolicy.ts:411` "*a determined command can still obfuscate a path*"）。OS 沙箱这一层对读**完全不设防**。

**攻击路径**（auto/YOLO 模式最相关，因为免确认 + 默认联网）：一条对读取路径做混淆、能绕过正则守卫的 bash 命令（例如把 `/Users/x/.ssh/id_rsa` 经 base64/变量拼接后再 `cat`），即可读取 `~/.ssh`、`~/.aws/credentials`、`/etc` 等；由于 `network` 默认 `unrestricted`，读到的内容可直接外发。bash 的 env 虽被 `filtered` 策略剥掉了 API key（`bash/index.ts:81-103`），但**磁盘上的密钥文件不在此保护范围**，且 PEM 私钥不匹配 `redactSensitiveShellOutput` 的 `key=value` 正则，会原样进入模型上下文。

**影响**：属于纵深防御缺口而非直接 RCE——正则守卫拦住了绝大多数直白写法，真正利用需要主动混淆读路径。但代码把 OS 沙箱宣传为"真正边界"，而它对读并不成立，这个认知偏差本身有风险。

**建议**（择一或组合）：
1. 默认给主沙箱和子代理沙箱注入一组 `readDenyPaths`（`~/.ssh`、`~/.aws`、`~/.config/gcloud`、`~/.gnupg`、`~/.npmrc` 等）——`spawn_sub_agent.ts:129` 已经把这类路径写进示例，说明机制现成，只是没有默认值。
2. auto 模式默认 `network: 'none'`，需要联网再显式开启。
3. 至少更新 `PermissionPolicy.ts` 注释，明确"OS 沙箱是**写**的 fail-closed 边界；**读**的边界仅为 best-effort 守卫"，避免后续维护者误判。

### P2-2 敏感命令模式清单在**交互模式**下漏掉了若干破坏性命令

**文件**：`src/kernel/permissions/SensitiveCommandPatterns.ts:25-59`

`SENSITIVE_SHELL_PATTERNS` 覆盖了 `rm`/`git push`/`chmod 777`/`sed -i` 等，但**没有**覆盖同样具备破坏性或数据丢失风险的：

- `>` 重定向截断（`echo x > important.conf` 会清空并覆盖文件）；
- `find … -delete`（等价批量删除，绕过 `rm` 正则）；
- `dd`（`dd of=…` 覆盖写）、`truncate`、`tee`（`tee important.conf`）、`mv`（覆盖目标）。

在 **auto 模式**这不是问题（本就免确认，安全靠沙箱）。但在**默认的 agentic/交互模式**，这些命令只要落在工作区内、通过路径守卫，就会**不弹确认直接执行**——而 `rm` 会弹。用户对"删除类操作会被拦一下"形成的心理预期，在 `find -delete` / `> file` 上并不成立。

**影响**：低-中。工作区内的误删/误覆盖，用户无二次确认机会。因为限定在工作区内，波及面有限。

**建议**：给该清单补充 `find … -delete`、`\btruncate\b`、`\bdd\b.*\bof=`、以及裸 `>`（非 `>>`）重定向的模式。注释（`SensitiveCommandPatterns.ts:16`）已说明"随时可加宽提示面，但别删安全控制"，与此建议一致。

---

## P3 — 低（健壮性 / 记录在案）

### P3-1 原子写缺少 fsync，掉电（而非进程崩溃）时日志序号指针可能超前于事件文件

**文件**：`src/infra/persist/index.ts:83-102`、`src/loop/graph/runtime/GraphStore.ts:591-600`

`atomicWriteJson/File` 采用标准的 write-tmp → `rename` 模式，但**不做 `fsync`**。这对**进程崩溃**是安全的（rename 原子，要么旧版本要么新版本）；但对**掉电/内核 panic**，rename 与数据落盘的顺序无保证：`appendEventLocked` 先写 `journal/<seq>.json` 再写 `journalSequenceJson`（`GraphStore.ts:597-598`），掉电可能留下"序号指针=N 但事件文件 N 缺失"的空洞。恢复时 `readLastSequenceLocked()+1` 会跳过 N 直接写 N+1，`reconcile` 读取时出现序号断档。

**影响**：低。代码明确以"进程崩溃可恢复"为设计目标（`persist/index.ts:78-81` 注释），掉电本就是更强的故障模型；且大多数场景为本地开发工具。但若该运行时用于**长周期无人值守 loop**（正是其卖点之一），掉电耐受性值得纳入考量。

**建议**：在关键日志写入路径（journal + sequence pointer）对 tmp 文件 `fsync` 后再 rename，并对目录项 `fsync`；或在文档里明确"崩溃恢复保证仅覆盖进程级崩溃，不含掉电"。

### P3-2 同一 `sessionId` 被两个进程并发续写时，分歧自愈会"最后写者全量覆盖"，可能丢消息

**文件**：`src/core/SessionStore.ts:378-396`

`append()` 在检测到 `index.messageCount !== appendFrom` 时，判定为分歧并**用调用方内存中的 transcript 全量 `atomicWriteFile` 覆盖**历史。注释已诚实说明这是"last-coherent-writer-wins"（`SessionStore.ts:374-377`）。后果是：若用户对**同一个 session id**同时跑两个进程（例如两个 `--resume last` 指向同一个 session），后提交者会覆盖先提交者的消息。

**影响**：低。这是被文档化的取舍，且并发续写同一 session 属于非常规操作；相比"抛错后永久停止持久化"，全量覆盖是更好的失败方向。

**建议**：仅作记录/文档提示——在 README 的 `--resume` 说明里点一句"同一 session 不要并发续写"。无需改代码。

---

## 已核查且实现正确的关键点（供参考）

以下是评审中重点验证、确认**没有问题**的部分，列出以说明覆盖面：

- **`web_fetch` 防 SSRF**（`tools/network/web_fetch/index.ts`）：DNS 解析后对**所有**返回地址做私网/环回/元数据/IPv4-mapped-IPv6 分类，任一命中即拒；连接阶段用自定义 `lookup` **钉扎到已验证 IP**，关闭了 DNS rebinding 窗口；手动跟随重定向、每跳重新校验；超过 `MAX_CONTENT*2` 立即 `res.destroy()` 防止无限流。实现正确。
- **`withFileLock`**（`infra/persist/index.ts:152-227`）：owner-token + `rename` 抢占 stale 锁 + 释放前校验 token，正确规避了"误删他人新锁导致双进入临界区"的经典缺陷。
- **`CommitCoordinator`**（`loop/graph/runtime/CommitCoordinator.ts`）：commitKey 幂等、serializable 重放上限、transition 求值 30s 超时且异常转为持久化 failed（避免 prepared intent 反复重放卡死）、外部事件深度/字节/去重校验，事件溯源一致性设计扎实。
- **`bash` 工具进程组管理**（`tools/shell/bash/index.ts:164-249`）：`detached` 独立进程组 + 超时/中断时 `kill(-pid)` 杀整组，`StringDecoder` 增量解码避免多字节 UTF-8 截断乱码。正确。
- **`JobManager`**（`jobs/JobManager.ts`）：终态持久化失败会 reject 等待者而非永久挂起（P1-9）、活动任务永不被 LRU 逐出、reattach 把中断任务归一为 failed。健壮。
- **权限策略**对写：路径守卫（绝对路径/`~`/`$HOME`/`..`/裸 `/`）+ auto 模式 lockWorkspace 强制忽略 `allowOutsideWorkspace` + OS 沙箱 fail-closed，多层一致。

---

## 修复优先级建议

| 优先级 | 项 | 工作量 | 说明 |
|---|---|---|---|
| 立即 | P1-1 删除自引用依赖 | 极小 | 一行；影响所有安装用户 |
| 高 | P2-1 读侧沙箱纵深（默认 readDenyPaths / auto 默认断网 / 修正注释） | 小-中 | 机制现成，主要是加默认值 |
| 中 | P2-2 敏感命令清单补 `find -delete`/`>`/`dd`/`tee` | 小 | 仅影响交互模式体验 |
| 低 | P3-1 关键日志 fsync 或文档化 | 中 | 取决于是否面向掉电场景 |
| 低 | P3-2 文档提示不要并发续写同一 session | 极小 | 纯文档 |

---

*说明：本次评审为静态源码分析，未运行 `tsc --noEmit` 或测试套件。建议在应用 P1-1 修复后，于干净环境 `npm pack && npm i` 做一次真实安装冒烟测试。*
