# 补充测试计划

> ## ✅ 第一批已落地（P0-1 / P0-2 / P1-3 / P1-4）
>
> **190 文件 / 1704 用例全绿**（本批之前 183 / 1540，**+164 例**），`tsc` 零错误，构建与 CLI 冒烟通过。
>
> **`units/` 与 `provenance/` 经核查不是 campaign 专用** —— campaign 目录对二者零引用。
> 实际消费者：`units/` → `DimensionChecker` → `createDefaultVVChain()` 默认注册 + 公开 API；
> `provenance/` → `robotics/RoboticsSession` 经 `createRoboticsRuntimeContext` 实际构造 + 4 个 agent 工具 + 公开 API。
> 所以按原计划补测。
>
> **顺带修掉了 P3-2 沙箱句柄竞态**，并用测试实证：修复前 4 个并发调用创建 **4 个** handle（应为 1），
> `dispose()` 只销毁 2 个中的 1 个 —— 泄漏属实。
>
> 覆盖率变化（v8 实测）：
>
> | 模块 | 之前 | 之后 |
> | --- | --- | --- |
> | `sandbox/`（整体） | 21.23% | **82.30%** |
> | `LinuxSandboxExecutor` | **0%** | **100%** |
> | `MacOSSandboxExecutor` | **0%** | **100%** |
> | `NoopSandboxExecutor` | **0%** | 80% |
> | `sandbox/index.ts`（工厂+降级） | 33.33% | **100%** |
> | `configuredWritePaths` | **0%** | **100%** |
> | `modes/toolRuntimeGuards` | 未测 | **97.50%** |
> | `units/` | **0 个测试** | **93.70%** |
> | `provenance/` | **0 个测试** | **91.80%** |
>
> 剩余 P2/P3 项（daemon 锁、ExperienceWorkingSet、OOMChecker、HttpMcpClient、CanUseTool、NodeExecutors）
> 仍待做，见下文。

- **依据**：`TEST_AUDIT.md` 的 v8 实测覆盖率 + 导出符号引用分析
- **现状基线**：190 文件 / 1704 用例全绿
- **排除**：campaign 相关模块（开发中）

---

## 判断标准

我只提名同时满足两条的目标：

1. **失效代价高** —— 出问题会造成安全边界失效、数据损坏、静默错误结论，而不是报个错就完事；
2. **测试成本低于风险** —— 有清晰的 seam（纯函数、可注入依赖、可导出入口），不需要为了测试重写实现。

不提名的（说明理由，避免"看起来没测"的误判）：

| 模块 | 为什么不提 |
| --- | --- |
| `cli/repl.ts`、`cli/stream.ts` | 交互式终端，需要 PTY 夹具，投入产出比差。真要做应先抽 `ReplSession` 状态机（见 `CODE_REVIEW.md`） |
| `kernel/messages/DeepSeekMessageNormalizer` | **已有测试**（我上一版报告把它和 `DeepSeekClient.ts` 混为一谈了，这里更正） |
| `AutoStallGuard`/`VerifyGate`/`DriftGate`/`AutoCompact`/`ToolOrchestration`/`ToolExecution` | 均已有 1–3 个测试文件，覆盖良好 |
| `GraphKernel`/`GraphStore`/`WakeStore`/`CommitCoordinator` | 3–4 个测试文件，图运行时是全仓覆盖最好的部分 |
| `coordination/*` | campaign 范畴，本轮排除 |
| `*/types.ts` | 纯类型，无运行时行为 |

---

## P0 —— 安全边界，且已经出过真 bug

### 1. `sandbox/` 执行器与工厂

**为什么**：这是 README 声称的**唯一真实 containment 边界**。实测 profile 生成器 92%，但三个执行器 + 工厂**全是 0%**：

```
LinuxSandboxExecutor.ts    0%
MacOSSandboxExecutor.ts    0%
NoopSandboxExecutor.ts     0%
sandbox/index.ts (工厂)    33%
```

P2-2（ESM `require` 导致嵌套检测永久失效）就住在这一层，正是因为没有测试才活了那么久。

**seam**：`wrapExec()` 是纯函数；`create()` 的分支只依赖 `detect.js` 的三个布尔探针 —— `vi.mock('./detect.js')` 即可完全控制，**不需要真的装 bwrap**。

**建议用例（约 14 条）**

| # | 用例 | 断言要点 |
| --- | --- | --- |
| 1 | `NoopHandle.wrapExec` | 返回 `{file:'bash', args:['-c',cmd]}`，与无沙箱路径逐字一致 |
| 2 | `LinuxHandle.wrapExec` | 参数以 `--` 结尾后接 `bash -c <cmd>`；命令不被拆词 |
| 3 | 命令含空格/引号/换行 | `wrapExec` 不做任何 shell 拼接，注入不可能发生 |
| 4 | Linux：bwrap 不可用 + `create()` | 抛错且信息包含安装指引 |
| 5 | Linux：嵌套 bwrap + `allowUnsandboxedFallback:false` | **抛错**（fail-closed，auto 模式依赖这条） |
| 6 | Linux：嵌套 bwrap + `allowUnsandboxedFallback:true` | 返回 NoopFallbackHandle **并**写 stderr 警告 |
| 7 | macOS：sandbox-exec 不可用 | 抛错 |
| 8 | 工厂：macOS + 可用 | 返回 MacOSSandboxExecutor |
| 9 | 工厂：Linux + bwrap 可用 | 返回 LinuxSandboxExecutor |
| 10 | 工厂：都不可用 | 返回 Noop **且** stderr 警告**只打一次**（一次性闩锁） |
| 11 | `describeSandboxBackend()` 四种组合 | `enforced` 与 `reason` 一致；未生效时 `reason` 非空 |
| 12 | 嵌套 bwrap 下 `describeSandboxBackend()` | 报 `backend:'none'` 且 reason 指向嵌套 |
| 13 | `ToolRuntimeGuards`：`lockWorkspace` + 无后端 | `getOrCreateSandboxHandle` 抛错（auto 模式 fail-closed 的实际入口） |
| 14 | `ToolRuntimeGuards`：并发两次取 handle | 只创建一个（当前有竞态，会创建两个并泄漏一个 —— **这条会红，是真 bug**） |

> ⚠️ 第 14 条我预计**当前会失败**：`getOrCreateSandboxHandle` 在 `await executor.create()` 期间没有占位，两个并发 bash 调用会各建一个 handle，后写入的覆盖先写入的，被覆盖的那个永远进不了 `dispose()`。现在句柄无状态所以无害，但这是等未来有状态后端来引爆的坑（即 `CODE_REVIEW.md` 的 P3-2）。要不要顺手修，你定。

**成本**：S（半天）

---

### 2. `sandbox/configuredWritePaths.ts`（0%）

**为什么**：这个函数决定**把哪些宿主路径挂成可写**进沙箱。它是配置 → 安全策略的转换器，写错就是越权写。38 行，纯逻辑，零测试。

**建议用例（约 8 条）**

| # | 输入 | 期望 |
| --- | --- | --- |
| 1 | `sandbox.writeAllowPaths` 非数组 | `[]`（不因配置畸形而放行） |
| 2 | `"~"` | 展开为 `homedir()` |
| 3 | `"~/data"` | 展开为 `<home>/data` |
| 4 | 相对路径 `"./out"` | **丢弃**（不得相对 projectDir 解析出宿主路径） |
| 5 | 不存在的绝对路径 | **丢弃**（bwrap 绑定源必须存在，否则整个沙箱起不来） |
| 6 | 重复路径 / `a` 与 `a/` | 去重 |
| 7 | 空串、纯空白、非字符串项 | 跳过而不抛 |
| 8 | `getConfigValue` 抛错 | 返回 `[]`（fail-closed，不是 fail-open） |

另测 `resolveHostPathRequirement`：`~` / `~/x` / 绝对 / 相对 四种形态。

**成本**：XS（1 小时）

---

## P1 —— README 卖点，纯函数，零测试

### 3. `units/`（879 行，**0 个测试**）

**为什么**：README 把"单位与量纲系统""V&V 量纲检查"列为核心能力，用于防止"仿真很美、上机就炸"。而这套东西**一条测试都没有**。它同时是全仓**最容易测**的代码：纯函数、无 I/O、无并发、无时间依赖。

**`dimensions.ts`（约 10 条）**

- `multiplyDimensions`：指数相加；结果为 0 的维度被消去（`m/s × s = m`，不是 `m·s⁰`）
- `invertDimension`：指数取负；两次求逆回到原值
- `dimensionsMatch`：`{}` 与 `DIMENSIONLESS` 等价；顺序无关；零指数与缺失键等价
- `identifyDimension`：能认出 velocity / acceleration / force；认不出的组合返回 `null`
- `formatDimension`：`DIMENSIONLESS` 的输出形态；负指数渲染

**`UnitRegistry`（约 12 条）**

- `convertValue` 往返：`m→km→m` 数值还原（浮点用 `toBeCloseTo`）
- **仿射单位**：`0°C = 273.15K`、`32°F = 0°C` —— 这是最容易写错的一类，必须钉死
- 跨维度转换（`m → s`）返回 `null` 而不是抛错或给出错误数字
- 未知单位返回 `null`
- `convert()` 的**不确定度传播**：线性单位按比例缩放；仿射单位（°C/°F）取绝对差 —— 源码注释说这是近似，应有测试固定当前语义
- `register()` 覆盖内建单位后 `get()` 生效
- `knownUnits()` 包含全部内建符号

**`DimensionalConsistencyChecker`（约 10 条）**

- 字段未声明 dimension → 跳过，不报错
- 值为 `undefined`/`null` → 按当前语义（缺失 vs 忽略）断言
- 值不是 `PhysicalQuantity` 形状 → 报 `dimension` 类错误
- 维度不匹配 → 报错，且错误里带字段名与期望/实际维度
- 维度匹配 → 无错误
- `checkInput` 与 `checkOutput` 的 `direction` 字段正确
- 多字段同时出错 → 全部返回而不是短路第一个

**成本**：S（一天）。**这是整个计划里性价比最高的一项。**

---

### 4. `provenance/ProvenanceTracker`（451 行，**0 个测试**）

**为什么**：README 的"provenance 数据溯源与血缘追踪"。它有 LRU 缓存 + 磁盘持久化 + 哈希去重 + 链式回溯，每一项都有静默出错的可能（比如链断了只是少几条记录，没人会发现）。

**建议用例（约 12 条）**

- `record()` → `get()` 往返；返回稳定 id
- `get()` 未知 id → `null`
- 重启（新建 tracker 实例，同 sessionId）后仍能 `get()` 到（走磁盘）
- `findDuplicate()`：相同输入内容命中；**键顺序不同的等价对象**是否命中（当前用 `sha256(JSON.stringify)`，对键序敏感 —— 值得钉死当前语义）
- `chain()`：三级 parent 链完整返回且顺序正确
- `chain()`：**parent 指向不存在的 id** → 不无限循环、不抛错
- `chain()`：**环形引用**（a→b→a）→ 必须终止（这类代码最常见的挂法）
- `list()` 各 filter 组合
- `_evictCacheIfNeeded`：超过上限后最旧的被逐出，但**磁盘仍可读回**（缓存不是真相来源）
- `summary()` 输出包含关键字段
- 磁盘上某条记录损坏 → `list()` 跳过它而不是整体失败

**成本**：S（半天）

---

### 5. 三个零覆盖的 fs 工具

`read_file`(85行) / `append_file`(42行) / `notebook_edit`(66行) 均 **0%**。其中 `notebook_edit` 声明为 `sensitive: true` + `category: 'write'`，是有权限语义的写工具。

**`read_file`（约 8 条）**

- `offset`/`limit` 分页正确；`offset` 越界 → 空而非崩
- `offset=0` 被钳到 1（源码 `Math.max(1, ...)`）
- 截断时 footer 行号区间正确（`[Showing lines a–b of N]`）
- 不存在的文件 → `isError` 且信息可读
- 目录路径 → 不抛未捕获异常
- 工作区外路径 → 被拒（与 `PermissionPolicy` 一致）

**`append_file`（约 5 条）**

- 追加到不存在的文件（创建 vs 报错，钉死当前语义）
- 连续追加顺序正确
- 工作区外路径被拒
- 与 `write_file` 的 `WriteMutex` 交互（auto 模式下同路径串行）

**`notebook_edit`（约 6 条）**

- 编辑指定 cell；cell 索引越界；非法 JSON notebook；保持其他 cell 不变
- 权限声明生效：plan 模式下 `ask`、工作区外拒绝

**成本**：S（半天）

---

## P2 —— 有真实并发/协议风险

### 6. `loop/daemon.ts` 锁（0%）

`acquireDaemonLock` / `releaseDaemonLock` 已导出，可直接测。这是**跨进程互斥**，错了会两个调度器同时跑同一 workspace。

**建议用例（约 8 条）**

- 获取 → 释放 → 可再获取
- 已被**活进程**持有（写一个 pid=process.pid 的新鲜锁）→ 返回 `null`
- 锁**内容损坏**（非 JSON）且仍新鲜 → 保守返回 `null`
- 锁损坏且已过期 → 可回收
- 锁**过期**（mtime 老于 freshMs）→ 可回收
- 持有者 pid 已死 + 同主机 → 可回收
- **另一台主机**持有且新鲜 → 不回收（`held.host !== hostname()` 分支）
- `releaseDaemonLock` 用**错误 token** → 不删别人的锁
- 并发 10 个 `acquireDaemonLock` → **恰好 1 个**拿到（`link()` 的原子性）

**成本**：M（半天—一天，需要控制 mtime，可用 `utimes`）

---

### 7. `robotics/ExperienceWorkingSet`（374 行，0 测试）

**为什么**：README 强调"刻意从严，噪声上下文比没有上下文更糟"，硬上限 4 条。这个"从严"逻辑如果悄悄失效（比如注入了 20 条无关经验），**不会报错，只会让模型变笨** —— 典型的静默失效。

`ExperienceWorkingSetDeps` 是构造器注入，`flashClient` 允许为 `null`，**天然可测**。

**建议用例（约 10 条）**

- `flashClient: null` → 走本地启发式排序，不崩
- 注入数量**永不超过** `EXPERIENCE_INJECTION_LIMIT`（4）
- flash 返回非法 JSON / 返回不存在的 id → 被过滤掉而非注入垃圾
- flash 返回超量 id → 被 `slice` 截断
- 领域无重叠时是否重新加载候选池（`_workingSetDomains` 分支）
- `forceReload()` 使下次 `preload` 重新拉候选
- `intent` 为 `null` 的早退分支
- `lastPreloadTrace` 记录了实际决策依据（可观测性）

**成本**：M

---

### 8. `validation/built-in/OOMChecker`（221 行，0 测试）

README 的 "V&V Hook（量纲/单位/物理约束/OOM）"。纯计算，易测。

**用例**：张量/网格尺寸 → 预估内存；跨过阈值报警、未跨过不报警；单位换算边界（GB/GiB）；溢出与 `NaN` 输入不产生误报。

**成本**：S

---

### 9. `tools/mcp/HttpMcpClient`（269 行，0 测试）

stdio 客户端本轮已补到 8 条；HTTP 传输仍是零。

**用例**：`initialize` 握手 + `mcp-session-id` 的保存与回传；`Authorization: Bearer` 与 `extraHeaders` 的**优先级**（源码注释说 extraHeaders 后合并会覆盖）；非 2xx 的错误形状；`content-type` 非 JSON；SSE 与 streamable-http 两种响应形态。用 `vi.stubGlobal('fetch', …)`，无需真实网络。

**成本**：M

---

## P3 —— 便宜的语义钉子

### 10. `kernel/permissions/CanUseTool.ts`（0%）

3 行代码，但它是**默认权限判定 = 全部放行**。值得一条显式测试把这个选择变成"有意为之且被看见"的，而不是某天被人当 bug 改掉。

**用例**：`defaultCanUseTool` 对任意工具返回 `{behavior:'allow'}`；`KernelSession` 未配置 `canUseTool` 时确实用它。

**成本**：XS（15 分钟）

### 11. `loop/graph/runtime/NodeExecutors.ts`（681 行，0 测试）

图运行时其余部分覆盖良好（`GraphKernel`/`GraphStore`/`CommitCoordinator` 各 1–4 个测试文件），`NodeExecutors` 是唯一缺口。它执行 agent/function/effect/wait/join 五类节点。

**用例**：五类节点各一条 happy path + 一条失败路径；`writeDenyPaths` 注入正确传递到子会话。

**成本**：M–L（依赖较重，建议排在最后）

---

## 汇总

| 优先级 | 目标 | 预计用例数 | 成本 | 核心理由 |
| --- | --- | --- | --- | --- |
| **P0-1** | sandbox 执行器 + 工厂 | ~14 | S | 唯一真 containment 边界，0%，已出过 bug；含 1 条预期会红的竞态 |
| **P0-2** | `configuredWritePaths` | ~10 | XS | 决定哪些宿主路径可写，0% |
| **P1-3** | `units/` | ~32 | S | 879 行纯函数 + README 卖点 + 零测试，**性价比最高** |
| **P1-4** | `ProvenanceTracker` | ~12 | S | README 卖点，含环形链等易挂路径 |
| **P1-5** | `read_file`/`append_file`/`notebook_edit` | ~19 | S | 三个 fs 工具 0%，含一个 sensitive 写工具 |
| **P2-6** | `daemon` 锁 | ~9 | M | 跨进程互斥，错了会双调度器 |
| **P2-7** | `ExperienceWorkingSet` | ~10 | M | 静默失效型风险（模型变笨但不报错） |
| **P2-8** | `OOMChecker` | ~6 | S | V&V 卖点 |
| **P2-9** | `HttpMcpClient` | ~8 | M | 远程传输 0% |
| **P3-10** | `CanUseTool` 默认值 | 2 | XS | 把安全默认变成显式契约 |
| **P3-11** | `NodeExecutors` | ~10 | M–L | 图运行时唯一缺口 |

**合计约 132 条用例**，其中 **P0-1 / P0-2 / P1-3 / P1-4 已完成（实际落地 164 例）**。

---

## 第一批落地明细

| 新增文件 | 用例 | 覆盖内容 |
| --- | --- | --- |
| `sandbox/__tests__/executors.test.ts` | 22 | wrapExec argv 不可注入、create 决策表、工厂选择、降级告警一次性、`describeSandboxBackend` 五种组合 |
| `sandbox/__tests__/configuredWritePaths.test.ts` | 20 | `~` 展开、相对/不存在路径丢弃、去重、畸形与抛错配置 fail-closed |
| `modes/__tests__/toolRuntimeGuards.test.ts` | 13 | 句柄复用、**并发只建一个**、dispose 等待在途创建、失败不缓存、lockWorkspace fail-closed、写锁注入 |
| `units/__tests__/dimensions.test.ts` | 25 | 维度代数、零指数消去、求逆对合、`identifyDimension` 歧义优先级 |
| `units/__tests__/UnitRegistry.test.ts` | 28 | 线性往返、**仿射温度**（0°C=273.15K、32°F=0°C、−40 相等）、跨维度返回 null、不确定度传播 |
| `units/__tests__/DimensionalConsistencyChecker.test.ts` | 25 | 不误报（未声明/标量/缺失字段）、全量报错不短路、畸形量、`scanForQuantities`、convert/tryConvert/toSI |
| `provenance/__tests__/ProvenanceTracker.test.ts` | 31 | 往返、重启读盘、会话隔离、7 类 filter、**断链与环形 lineage 终止**、去重、损坏文件跳过、并发写不撞 tmp |

三处刻意"钉死当前语义而非理想语义"，均在测试里写明理由：

- `findDuplicate` 对 JSON **键顺序敏感**（`{a,b}` 与 `{b,a}` 哈希不同）→ 标为 `DOCUMENTED LIMITATION`；将来若改用 canonical stringify，这条测试就是提示你行为变了的那一条。
- 仿射单位的**不确定度传播是近似**（源码注释自陈 "approximate but acceptable for 1σ"）→ 标为 `DOCUMENTED APPROXIMATION`。
- `identifyDimension` 对 PRESSURE/STRESS、ENERGY/TORQUE 这类**同维度别名返回表中第一个** → 钉住当前顺序，使表的重排成为可见变更。

顺带清理：`vitest.config.ts` 里 `src/core/auto_orch/**` 的排除项已删除 —— 那些空壳文件上一轮已真正删掉，排除项随之失效。

---

## 剩余项（未做）

P2-6 daemon 锁、P2-7 ExperienceWorkingSet、P2-8 OOMChecker、P2-9 HttpMcpClient、P3-10 CanUseTool、P3-11 NodeExecutors —— 约 45 条，详见上方汇总表。

`sandbox/detect.ts` 停在 **48%** 是有意为之：执行器测试把它整个 mock 掉了，而它剩下的部分是 `execFileSync('bwrap', ['--version'])` 这类真实探针，没有对应二进制时无法有意义地单测。真要覆盖需要集成环境，投入产出比不划算。

---

## 一条仍然有效的建议

给剩余模块补测时继续沿用「**先固定现状 + 注释说明**」的做法，不要在补测的同一轮里顺手改实现 —— 否则测试红了分不清是实现错还是断言错。本批的三处 `DOCUMENTED *` 标记就是这个原则的落地。
