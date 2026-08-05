# 回归验证 + 测试审计报告

- **对象**：`@meta-agent/runtime` 0.8.7（在 `CODE_REVIEW.md` 修复轮次之后）
- **范围**：排除 campaign 相关代码（开发中）
- **日期**：2026-08-04

---

## 一、回归验证结论

**改动是完整的，没有引起其他功能异常。** 逐项证据如下。

### 1.1 基线

| 项目 | 修复前 | 现在 |
| --- | --- | --- |
| `tsc --noEmit` | 0 错误 | **0 错误** |
| 测试文件 | 178 | **183** |
| 测试用例 | 1450 | **1540**（+90） |
| 失败用例 | 0 | **0** |
| `npm run build` | 通过 | **通过** |
| `check-publishable-manifest` | 通过 | **通过** |
| CLI 冒烟（`--version`/`--help`/`env`/`loop list`/无 key 报错） | — | **全部正常** |

### 1.2 CLI 拆分：零代码丢失（机械核对，非目测）

用脚本把 `git show HEAD:src/cli/index.ts` 与拆分后 18 个模块做了两轮比对：

- **顶层声明**：原文件 126 个声明，新模块合计 174 个，**缺失 0 个**。
- **代码行**：归一化（剔除 import / 注释 / 纯括号行、抹平 `export ` 前缀）后逐行比对，
  原文件 3,198 条不同代码行中「缺失或减少」的只有 **21 条**，逐条核对全部是**有意改写**：
  - 8 条：颜色助手移入 `term.ts` 时补了 `: string` 返回类型
  - 3 条：`startsWith(workspace)` → `isWorkspaceLocalPath`（P2-8 修复本身）
  - 2 条：`_mcpServerInstructions` → `getMcpServerInstructions()`
  - 1 条：`env --json` 输出增加 `sandbox` 字段（P1-4）
  - 1 条：`_activeThinkingMeter = null` → `setActiveThinkingMeter(null)`
  - 2 条：`streamPrompt` 返回值增加 `degenerateLoop`（**这是你未提交的在制品**，不在 HEAD 里，属于比对基线差异而非丢失）
  - 4 条：import 形状/换行调整

### 1.3 影响面：`cli/` 是 bin-only，不触及公共 API

- `src/index.ts`（库入口）**没有**从 `cli/` 再导出任何东西 → 拆分不可能影响 npm 包的公共接口。
- `cli/` 之外只有两处引用 `cli/version.ts`（`loop/daemon.ts` 是既有的，`tools/mcp/mcpConfigFile.ts` 是本轮为 MCP `clientInfo.version` 新增的）。
- `dist/` 已包含全部新模块（33 个 js/d.ts），发布清单校验通过。

### 1.4 修复过程中发现并修正的自身问题

| 问题 | 说明 |
| --- | --- |
| **过度导出 18 个符号** | 拆分时为了让编译通过，把只在模块内部使用的函数/类型也 `export` 了，等于凭空放大了模块 API。已全部收回为模块私有，`tsc` 仍然干净。 |
| **我自己让一个测试失效了** | `ExperienceStore.test.ts` 断言 `${first}.json.corrupt` 不存在；我把隔离文件名改成带时间戳后，这条断言**无论如何都会通过**（名字不再匹配）。已改为按后缀扫描目录，并做了变异验证：注入一个假的隔离文件后该用例确实失败。 |

---

## 二、修复项的端到端验证（不是"能编译"，是"确实生效"）

对每一项都做了**变异测试**：把实现改回修复前的样子，确认新测试会红；再恢复，确认变绿。

| 修复 | 验证方式 | 结果 |
| --- | --- | --- |
| **P2-2** ESM `require` | 本机环境**本身就嵌套在 bwrap 内**，且 `BWRAP_SANDBOX_PID` 未设置。修复后 `isInsideBwrap()` 经 `/proc/1/cmdline` 正确返回 `true` | ✅ 实测生效 |
| **P2-7** 槽位泄漏 + 未捕获拒绝 | 新增 `SlotReleaseOnSettleFailure.test.ts`（3 例）。回滚到原 `.catch().finally(async)` 实现后：1 例因 unhandled rejection 失败，2 例因**队列死锁**超时 | ✅ **死锁被实证确认**，不再只是推理 |
| **P2-8** CLI 前缀匹配 | 新增 `cli/__tests__/guards.test.ts`（12 例）。把 `isInsideWorkspace` 换回 `startsWith` 后，"同名兄弟目录"与"符号链接逃逸"两例立刻失败 | ✅ |
| **P1-3** `/dev/` 白名单 | 逃逸表中 3 条块设备用例（`dd of=/dev/sda`、`mkfs /dev/nvme0n1`、`> /dev/sdb`） | ✅ |
| **P1-2** `bash.sensitive` | 逃逸表中 4 条配置权威性用例 | ✅ |
| **P3-1** `~`/`..` 误报 | 逃逸表中 6 条合法命令（awk/perl/bash 正则、git range） | ✅ |
| **P2-3** 锁续期 | `lockHeartbeat.test.ts`（4 例，含"长临界区不被误抢"与"真孤儿锁仍可回收"） | ✅ |
| **P2-5/P2-6** MCP | `StdioMcpClient.test.ts`（8 例，含同一 pid 复用、跨调用状态保持、乱序 id 路由、进程死亡后重启、凭证过滤） | ✅ |
| **P3-7/P3-8** tmp 残留 / `.corrupt` 覆盖 | 新增 `atomicWrite.test.ts`（9 例，用**真实 rename 失败**而非 mock：向非空目录 rename 会触发 OS 级失败） | ✅ |
| **P3-4** NUL 字节 | 全 `src/` 扫描，**无任何文件**含控制字符 | ✅ |
| **P1-4** 沙箱降级 | CLI `env` 与 `env --json` 实际输出中均正确报告 `backend: none` 与原因 | ✅ |

**新增测试合计 +90 例**（sandbox 契约 14、逃逸表 41、锁心跳 4、原子写 9、CLI guards 12、槽位释放 3、KernelSession 工具注册 +3、MCP +5）。

---

## 三、测试审计

### 3.1 无效 / 过期测试（已清理）

#### (a) 9 个空壳测试文件 + 22 个空壳源文件 —— 已删除

`src/core/auto_orch/` 下所有文件内容都只有一行：

```
// RETIRED (T4.3b): v1 auto_orch removed. File emptied in-place because this
// sandbox mount forbids unlink; run `git rm -r src/core/auto_orch` to finalize.
```

即：**上一次清理因为沙箱不能删文件而没做完，文件里明确写着请求补做**。已执行 `rm -r`，并同步移除 `package.json` 中随之失效的 `"!dist/core/auto_orch/**"` 排除项。

#### (b) 一个纯粹为"让 vitest 不报空目录"而存在的同义反复测试 —— 已删除

```ts
// cli/__tests__/teamWriteGuard.test.ts
it('exports nothing', async () => {
  const mod = await import('../teamWriteGuard.js')
  expect(Object.keys(mod)).toEqual([])     // 断言一个 `export {}` 模块导出为空
})
```

注释自陈"This placeholder keeps vitest happy with non-empty test files"。连同被测的 `cli/teamWriteGuard.ts`（内容为 `export {}`）与 `robotics/validation/HardwareSafetyChecker.ts`（内容为 `export {}`）一并删除 —— 三者都无任何引用。

#### (c) 三个**零断言**的安慰剂测试 —— 已重写

`kernel/__tests__/KernelSession.test.ts` 里有三个用例完全没有 `expect()`，注释还写明了原因：

```ts
it('addTool adds a new tool', () => {
  session.addTool(makeTool('my_tool'))
  // We can't inspect _config directly, so we verify indirectly via the stream call
  //                                      ↑ 但下面并没有这么做
})
it('addTool ignores duplicate (no-op)', () => {
  session.addTool(tool); session.addTool(tool)
  // No assertion needed — just ensuring no error is thrown
})
```

这类用例对 `addTool(){}`（空实现）同样会通过。已改为通过被 mock 的 `streamMessages` 观察**实际发给模型的工具列表**（这才是真正重要的可观测面），并补齐了"重名保留首个"、"upsert 保持位置"等语义，共 6 例。

**变异验证**：把 `addTool` 改成空函数后，新用例 4 例立刻失败；原来的 3 例则一例都不会失败。

### 3.2 其余测试的健康度：良好

| 检查项 | 结果 |
| --- | --- |
| `.skip` / `.todo` / `.only` / `xit` | **0 处**（无被静默跳过的用例） |
| 零断言的测试文件 | 清理后 **0 个** |
| `it()` 块总数 / `expect()` 总数 | 1,452 / 3,468 ≈ **每例 2.4 条断言**，密度健康 |
| 弱断言（`toBeDefined`/`toBeTruthy`/`not.toThrow`） | 45 处，占断言总数 **1.3%**，且多数是"不抛异常"本身就是被测语义（如 `dispose()` 幂等） |

一处**风格**建议（非缺陷）：`robotics/team/__tests__/TeamStore.views.test.ts` 用 `waitForFile()` 代替断言 —— 该 helper 找不到文件会抛错，所以功能上是有效断言，但失败信息不如 `expect` 直观。

### 3.3 覆盖盲区（用 v8 实测，非估算）

安全 / 持久化关键模块的真实覆盖率：

```
File                    | % Stmts | % Branch | % Funcs | % Lines
------------------------|---------|----------|---------|--------
sandbox/                |   21.23 |    16.17 |   24.13 |   21.21
  LinuxSandboxExecutor  |       0 |        0 |       0 |       0   ← 全未覆盖
  MacOSSandboxExecutor  |       0 |        0 |       0 |       0   ← 全未覆盖
  NoopSandboxExecutor   |       0 |      100 |       0 |       0   ← 全未覆盖
  configuredWritePaths  |       0 |        0 |       0 |       0   ← 全未覆盖
  detect.ts             |   48.64 |    38.88 |    62.5 |   48.38
  index.ts (工厂+降级)   |   33.33 |    18.18 |   66.66 |   33.33
sandbox/profiles/       |   92.50 |    96.15 |     100 |   92.50   ← 本轮新增
kernel/permissions/     |   74.82 |    62.80 |   84.21 |   75.00
  SensitiveCommandPat.  |     100 |      100 |     100 |     100
  CanUseTool.ts         |       0 |      100 |       0 |       0   ← 默认权限函数未覆盖
infra/persist/          |   84.92 |    63.26 |      60 |   86.66   ← 本轮提升
tools/fs/workspaceGuard |   87.50 |    64.51 |   83.33 |   90.90
```

**结论：profile 生成器（"沙箱长什么样"）现在覆盖良好，但执行器（"到底要不要沙箱、返回哪个 handle"）三个文件全是 0%** —— 而 P2-2 那个 bug 恰恰就住在这一层。这是当前最值得补的地方。

同时，以下**被 README 当作卖点**的模块**一个测试都没有**：

| 模块 | LOC | README 中的定位 | 测试 |
| --- | --- | --- | --- |
| `provenance/` | 451 | "provenance 数据溯源与血缘追踪" | **0** |
| `units/` | 879 | "单位与量纲系统"、V&V 量纲检查 | **0** |
| `validation/built-in/OOMChecker.ts` | 221 | "V&V Hook（量纲/单位/物理约束/OOM）" | **0** |
| `tools/mcp/HttpMcpClient.ts` | 269 | 远程 MCP 传输 | **0** |
| `kernel/api/DeepSeekClient.ts` | 500 | 两个协议适配器之一 | **0** |
| `robotics/ExperienceWorkingSet.ts` | 374 | "每轮挑最多 4 条相关经验注入" | **0** |
| `loop/daemon.ts` | 213 | 调度器锁与心跳 | **0** |

`units/` 和 `provenance/` 尤其可惜：**都是纯函数、无 I/O、无并发**，是整个代码库里写测试成本最低、而当前收益最高的地方。

### 3.4 建议的补测优先级

| 优先级 | 目标 | 理由 | 成本 |
| --- | --- | --- | --- |
| 1 | `sandbox/*Executor.ts` + `index.ts` 工厂 | 唯一的真实containment 边界，执行器 0% 覆盖，已出过一个真 bug | S |
| 2 | `units/`（UnitRegistry + DimensionalConsistencyChecker） | 879 行纯函数、README 卖点、零测试 | S |
| 3 | `provenance/ProvenanceTracker` | 451 行、README 卖点、零测试 | S |
| 4 | `kernel/permissions/CanUseTool.ts` | 默认权限判定，0% | XS |
| 5 | `tools/fs/{read_file,append_file,notebook_edit}` | 三个 fs 工具 0% 覆盖，其中 notebook_edit 声明为 `sensitive` | S |
| 6 | `kernel/api/DeepSeekClient` 消息规范化 | 500 行协议适配，靠线上才发现问题成本高 | M |
| 7 | `loop/daemon.ts` 锁获取/回收 | 已有 `withFileLock` 测试可参照 | M |

### 3.5 工具链改进（已落地）

仓库此前**没有安装任何覆盖率工具**，`npm run test` 只能回答"有没有红"，无法回答"测到没测到"。已补：

- `devDependencies` 增加 `@vitest/coverage-v8`
- 新增脚本 `npm run test:coverage`（text + html 双报告）

---

## 三点五、后续补测已执行（第一批）

`TEST_PLAN.md` 的 P0-1 / P0-2 / P1-3 / P1-4 已落地，**+164 例**（183 文件 1540 例 → **190 文件 1704 例**）。

- 关于 3.3 里"`units/` 与 `provenance/` 零测试"的问题：经核查二者**都不是 campaign 专用**（campaign 目录零引用）。
  `units/` 经 `DimensionChecker` 被 `createDefaultVVChain()` 默认注册；`provenance/` 在 robotics 模式下由
  `createRoboticsRuntimeContext` 实际构造，并有 4 个 agent 工具。二者均属公开 API。因此按计划补测。
- 顺带修掉 `CODE_REVIEW.md` 的 **P3-2 沙箱句柄竞态**（缓存 Promise 而非已解析 handle）。测试实证：
  修复前 4 个并发调用创建 **4 个** handle（应为 1），`dispose()` 只销毁 2 个中的 1 个。
- `vitest.config.ts` 中 `src/core/auto_orch/**` 排除项已删除（对应空壳文件已在 3.1(a) 删除）。

覆盖率对照：

| 模块 | 补测前 | 补测后 |
| --- | --- | --- |
| `sandbox/`（整体） | 21.23% | **82.30%** |
| `LinuxSandboxExecutor` / `MacOSSandboxExecutor` | **0% / 0%** | **100% / 100%** |
| `sandbox/index.ts`（工厂 + 降级） | 33.33% | **100%** |
| `configuredWritePaths` | **0%** | **100%** |
| `modes/toolRuntimeGuards` | 未测 | **97.50%** |
| `units/` | **0 个测试** | **93.70%** |
| `provenance/` | **0 个测试** | **91.80%** |

`sandbox/detect.ts` 仍为 48%：执行器测试将其整体 mock，剩余部分是需要真实 bwrap/sandbox-exec 二进制的探针，单测无意义。

---

## 四、遗留事项（明确未做）

| 事项 | 状态 |
| --- | --- |
| **P1-1** 沙箱只挡写不挡读 / 网络默认放开 | 按你的决定**保留**。已在 `profileContract.test.ts` 中以两条 `DOCUMENTED GAP` 用例把缺口固化在测试套件里 |
| `TEST_PLAN.md` 的 P2/P3 项 | daemon 锁、ExperienceWorkingSet、OOMChecker、HttpMcpClient、CanUseTool、NodeExecutors，约 45 例，未做 |
| `cli/repl.ts` 仍 1,673 行 | slash 命令分发块引用 `runRepl` 的 25 个闭包变量、其中 12 个被写回。正确路径是先建模 `ReplSession` 类再拆，而非塞一个可变 context 对象。见 `CODE_REVIEW.md` 说明 |
| 上述 3.4 补测清单 | 未实施，按优先级列出 |

---

## 附：本次验证的执行记录

- `npx tsc --noEmit` → 0 错误
- `npx vitest run` → 183 文件 / 1540 用例全绿
- `npm run build` → 通过；`node dist/cli.mjs --version|--help|env|env --json|loop list|loop --help` → 正常；无 API key 时输出可读错误而非堆栈
- `node scripts/check-publishable-manifest.js` → 通过
- 变异测试：`addTool` 置空 / `isWorkspaceLocalPath` 回退 `startsWith` / `SubAgentBridge` 回退 `.catch().finally()` / `ExperienceStore` 注入假隔离文件 —— 四次变异，对应新测试全部如期变红，恢复后全部变绿
- 全 `src/` 控制字符扫描 → 无二进制源文件

> **一处需要你知道的环境事故**：安装覆盖率工具时 `npm i` 被 45s 超时中断，导致 `node_modules/@rolldown/binding-linux-arm64-gnu` 的原生二进制被写坏（12,075,008 字节 vs 正确的 17,399,064 字节），vitest 随即 Bus error。已定位并用 `npm pack` 拉取同版本原包**修复完毕**，`node_modules/.bin` 软链也已重建；随后 tsc / 全量测试 / 构建 / CLI 冒烟全部复验通过。`package.json` 与 `package-lock.json` 未被该次中断污染（`git diff` 已确认，仅含我的有意改动）。
