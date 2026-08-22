# auto 模式 verify / drift 关卡审查

> 审查日期：2026-08-21 · 版本基线：`0.9.0`
> 范围：`kernel/loop/VerifyGate.ts`、`kernel/loop/DriftGate.ts`、`KernelLoop` 触发段、
> `core/auto/verify/VerifyJudge.ts`、`core/auto/verify/JudgeSnapshot.ts`、
> `core/auto/learn/DriftAgent.ts`、`core/auto/AutoCheckpointCoordinator.ts`、
> `subagent/verdictChannel.ts`、`subagent/SubAgentBridge.ts`
> 方法：源码通读，每条结论标注文件:行号。

---

## 0. 一句话结论

**verify 是一个经过多轮加固的完成度审查；drift 是它维护得少得多的孪生兄弟，并且其核心判据在结构上不成立。**

两者共享同一套契约（kernel 定义 hook、session 层注入实现、双通道裁决、fail-closed 默认），这部分设计是干净的。问题集中在两处：

1. **drift 判断"是否偏离"所依据的 checkpoint，几乎全部由被审查者自己写入**——它并不像模块头部注释声称的那样独立于执行者的叙述。
2. **verify 明文禁止运行 typecheck/test/lint**，所以对"把构建跑绿"这类目标，护栏实际是"一个 LLM 读代码后觉得像是好了"。

其余是一批中低严重度的实现不一致，多数是 verify 已经解决、drift 没有同步的问题。

---

## 1. 触发时机

| | verify | drift |
| --- | --- | --- |
| 触发条件 | 模型本轮**不再发起任何工具调用**（自认为完成） | checkpoint revision 前进 **且** 距上次 drift ≥ 30 个 tool batch |
| 位置 | `KernelLoop.ts:1463`（no-tool-calls 分支内） | `KernelLoop.ts:1844`（工具批次执行后） |
| 上限 | `MAX_VERIFY_ROUNDS = 5`（`VerifyGate.ts:24`，**硬编码**） | `DRIFT_TURN_INTERVAL = 30`（`DriftGate.ts:24`，**硬编码**） |
| 关卡不可用时 | 重试 `autoGateMaxAttempts`(默认 2) → 按 `autoGateFailurePolicy`(默认 `checkpoint_pause`) 停止运行 | 同上，但允许连续失败 `autoDriftFailureLimit`(默认 3) 次后才停止 |

**观察 1（设计正确，但需知晓）— 熔断退出完全绕过 verify。**
verify 只在"模型主动停止调工具"这一条路径上触发。因 `max_turns` / `max_budget_usd` / `auto_runtime_limit` 退出的运行永远不会被审查。这是对的（那些运行本就没有声称完成），但意味着**一次烧完预算的运行不会留下任何"做到哪一步"的独立评估**，只有执行者自述的 checkpoint。

**观察 2（中）— drift 在短运行中从不触发。**
需要 30 个 tool batch。25 轮完成的任务全程零次航向检查。考虑到 drift 的成本（每次一个 30 轮 / $0.5 的子代理），这个默认值本身合理，但它**不可配置**——`DRIFT_TURN_INTERVAL` 是常量，而 drift 的预算 (`META_AGENT_DRIFT_MAX_BUDGET_USD`) 和 verify 的三项限额都是环境变量可覆盖的。节奏是这里最该可调的参数，偏偏是唯一写死的。

**观察 3（中）— drift 的节奏对运行轨迹完全无感。**
rubric 要求 drift agent 结合 `runHealth` 判断"前几次纠偏是否无效、是否在打转"（`DriftAgent.ts:65`），但**调度本身**不看这些：刚被判定 `major` 偏离并注入纠偏的运行，与一路顺畅的运行，下一次检查同样是 30 个 batch 之后。"纠偏是否被采纳"这个问题，最早要等 30 轮才有人问。

---

## 2. 可见的东西

### verify 看到什么

- **纯净的原始目标**（冻结的首个用户 prompt，`getGoal()`），**看不到执行者的推理与自述**——这一点是真的独立。
- 一个 **throwaway git 快照 worktree**（`JudgeSnapshot.ts`），用独立 index 做 `add -A` + `write-tree` + `commit-tree`，因此包含未提交的改动和新建文件。
- 预生成的 **`git diff --stat` + `THIS_ROUND.diff`**（上限 200KB），写进快照根目录供 `read_file` 直接读。
- **（0.9.0 新增）工具级改动清单**，补 git 的两个盲区（非 git 仓库、`.gitignore` 路径）。

### drift 看到什么

- 纯净的原始目标。
- **checkpoint JSON**：`completedSteps` / `pendingTodos` / `artifacts` / `note` / `turnCount` / `autoEditSummary` / `runHealth`。
- 既有经验块。
- **（0.9.0 新增）工具级改动 stat 块。**

### ⚠️ 严重发现 1：drift 的核心判据由被审查者自己写入

追踪 checkpoint 各字段的来源（`AgenticBackendFactory.ts:195-219`）：

| 字段 | 实际来源 |
| --- | --- |
| `completedSteps` | 执行者自己调 `todo_write` 标记为 completed 的条目 |
| `pendingTodos` | 执行者自己写的、尚未标完成的 todo |
| `note` | 执行者自己调 `progress_note` 写的进度note |
| `artifacts` | 执行者自己调 `artifacts_register` 登记的产物 |
| `autoEditSummary` | flash 模型对执行者改过的文件路径做的摘要 |
| `turnCount` / `runHealth` | 内核确定性计数（**唯一不由执行者控制的部分**） |

而 `DriftAgent.ts:13-15` 的模块注释写着：

> Judging drift from it keeps the agent independent of the executor's framing

**这个说法不成立。** 除 `turnCount` 和 `runHealth` 外，drift 读到的每一个字段都是执行者的自我陈述。一个已经跑偏的执行者，会把跑偏的工作写成条理清晰的 todo 并标记完成——drift 读到的于是是一份整洁、在轨的进度快照。**最可能证伪它的证据（磁盘上真实发生了什么变化）恰恰是 drift 唯一没有的东西。**

这与 verify 的设计形成刺眼对照：verify 明确不信任自述，只给纯目标 + 真实产物，并强制要求逐条举证。drift 拿着自述判独立性。

0.9.0 加入的工具级 diff 是**第一个**进入 drift 视野的非自述信号。这提高了它的价值，但也说明这个缺口存在了多久。

**建议**：把 `completedSteps` / `note` 在 prompt 里显式标注为"执行者自述，仅供参考，需与实际改动交叉验证"，并把改动清单提到 checkpoint 之前——先看事实，再看自述。

---

## 3. 可用工具

| | 工具集 | 隔离方式 |
| --- | --- | --- |
| verify（有快照） | `read_file` `grep` `glob` `bash` | `ephemeral_snapshot`，`projectDir` 指向快照，`sandbox: { writeAllowPaths: [快照], network: 'none' }` |
| verify（无快照，非 git 仓库） | `read_file` `grep` `glob`（**去掉 bash**） | `shared_readonly` |
| drift | `read_file` `grep` `glob` `bash` `experience_write` | `shared_readonly` |

`shared_readonly` 是**真enforcement**，不是建议（`SubAgentBridge.ts:601-611`）：过滤掉 write 类工具，并强制 `sandbox: { readonlyWorkspace: true, writeAllowPaths: [], allowUnsandboxedFallback: false }`。`bash` 因为是 `execute` 类不会被工具过滤器摘掉，但 OS 沙箱使工作区只读，所以它写不了。这一层是可靠的。

### 勘误：发现 2 已撤回

> **本条初稿断言"drift 的静态 rubric 会在无 bwrap 宿主上承诺一个 fail-closed 的
> bash"。查证后两个环节都不成立，予以撤回，原文保留在下方以说明错在哪里。**
>
> 1. **`bash` 不会被过滤掉。** `filterSharedReadonlyTools`（`SubAgentBridge.ts:90`）
>    判定写工具的规则是 `category === 'write'` / 在 `write_file|edit_file|notebook_edit`
>    名单内 / 名字以 `_write` 结尾。`bash` 是 `execute` 类，三条皆不中；
>    `experience_write` 虽以 `_write` 结尾但在豁免名单里。**`DRIFT_TOOLS` 五个工具
>    一个都不会被摘掉，硬编码的列表与实际授权一致。**
> 2. **无 backend 时不是"bash 调用失败"，而是子代理根本起不来。**
>    `SubAgentRunner.ts:286` 在启动阶段即抛错，rubric 一个字都不会被读到；这对
>    verify 同样成立。且这是 `sandbox/index.ts:73` 明确记载的有意 fail-closed
>    行为（"DEGRADATION IS NOW LOUD"），不是 drift 的缺陷。
>
> **剩下的只是一条未来的脆弱性**（不构成当前缺陷）：verify 生成工具行是因为它
> 真有两套工具集（快照带 bash / 活树不带）；drift 只有一套，所以硬编码今天是对的。
> 但哪天有人给 drift 加条件工具集，rubric 不会跟着变——那才会重演 verify 修过的
> 那个 bug。降级为备注。

### ~~发现 2（中）：drift 的 rubric 硬编码工具列表，verify 的是生成的~~（已撤回，见上）

`VerifyJudge.ts:110` 的 `buildJudgeRubric(allowedTools)` 从**实际授予的工具**生成 rubric 里的工具说明，注释明确说明理由：

> so the rubric never promises a tool the judge wasn't given (e.g. bash is dropped on the live-tree path) — a mismatch the judge would otherwise waste turns on

`DriftAgent.ts:55` 的 `DRIFT_RUBRIC` 是一个**静态常量**，把"可用只读工具（read_file/grep/glob/bash）"写死在文本里。

后果：`allowUnsandboxedFallback: false` 意味着在没有 bwrap / sandbox-exec 的宿主上，drift 的每次 bash 调用都会 fail-closed 报错，而 rubric 仍在承诺 bash 可用。这正是 verify 修掉的那一类 bug，drift 没有同步。

### 发现 3（低）：drift 可直接写共享经验库，绕过人工 review

`experience_write` 在 `DRIFT_TOOLS` 中，且 `AutoExperienceStore.ts:11-13` 明确记载：

> the drift agent calls `experience_write` (**direct, NOT queued for human review** — auto is unattended)

这是**有意的、有文档的**取舍。但需要意识到它的传播路径：drift 在第 30 轮写下一条经验 → `renderRecentExperiences` 每轮把它注入主 agent 上下文 → 影响该运行的余下全部决策，并持久留在 workspace 里（上限 60 条，超出按最旧淘汰）。而 README 把"AI 提议、人来裁决"描述为三类知识的统一纪律。**auto 模式是这条纪律的例外，README 没有说明这一点。**

一条由跑偏的 drift agent 写下的错误教训，会以复利方式污染同一个 workspace 的后续运行——这正是人工 review 机制被设计出来防止的场景。

---

## 4. Prompt / rubric 质量

### verify rubric（`VerifyJudge.ts:116-134`）

写得好的地方：

- 开篇即建立独立性：「你**没有**看到执行 Agent 的推理过程或它自称做了什么，这是刻意为之」。
- 强制举证：「给不出证据的"完成"不成立」，且要求 `file:行号`。
- 预算意识：「一旦接近轮次/预算上限，立即给出 JSON 裁决（哪怕 done:false）」——这条很关键，避免了耗尽预算却没有裁决的最坏结局。
- 工具行按实际授权生成。
- `done=true 时 unfinished 必须为空数组` —— 消除了自相矛盾的裁决。

### ⚠️ 严重发现 4：verify 明文禁止运行任何确定性检查

rubric 第 3 条（`VerifyJudge.ts:136`）：

> verify 不运行 typecheck/test/lint；你必须仅基于原始目标和亲自读取到的代码/产物作出 LLM 审核判断。

全仓确认：auto 的 verify 路径里没有任何测试/类型检查/lint 执行（grep `typecheck|npm test|vitest|lint` in `src/core/auto/` 仅命中这条 rubric 文本和一条对应注释）。

这意味着对于 auto 模式最典型的用法之一——

```bash
meta-agent --mode auto "把构建跑绿，修掉所有失败用例"
```

——**护栏是"一个 LLM 读了代码觉得像是修好了"**。verify 无法区分"测试真的过了"和"代码看起来应该能过"。

这个限制有其**结构性原因**，而且和我此前修的 diff 盲区同源：git 快照由 `add -A` 构建，遵守 `.gitignore`，因此 `node_modules/`、`build/`、`install/` 都不在快照里。在那个 worktree 里跑测试只会得到虚假的失败。所以禁令是诚实的——但代价是 `VerifyGate.ts:5` 那句「the real guardrail」高估了它实际提供的保证。

**这是整个 auto 自监督体系最大的单点弱项**，也是与 campaign 模式的显著反差：campaign 把「零 LLM 的确定性监控」作为明确设计价值（`CampaignMonitor`），auto 的两个关卡则**完全没有确定性成分**。

### drift rubric（`DriftAgent.ts:55-78`）

- 职责分离清晰（判偏离 + 沉淀经验），经验写入门槛严格（「没有确凿来源就不要写」「宁可不写，也不要凭猜测污染经验库」）。
- 结合 `runHealth` 判断轨迹的那段（第 65 行）写得相当好——把"打转"「刚被 verify 驳回」「压缩过多次」都翻译成了可操作的判断线索。
- 0.9.0 新增了改动清单的说明。

### 发现 5（中）：drift 的 `severity` 是纯装饰

rubric 要求 agent 区分 `minor` / `major`，解析器也认真处理（`DriftAgent.ts:134`）。但系统对两者的**行为完全一致**：

- `buildDriftCorrectionPrompt`（`DriftGate.ts:75`）只用它拼一个「（严重）」字样；
- `Verdict.ts:91` 只用它选一个 `drift_major` / `drift_minor` 标签；
- 没有更短的下次检查间隔、没有更高的注意力预算、没有强制停机。

让模型认真做一个不影响任何行为的判断，是在花 token 买装饰。要么让 `major` 触发实际后果（例如把下次 drift 间隔减半、或升级为需要人工确认的 checkpoint pause），要么把这个字段删掉。

### 发现 6（中）：纠偏没有闭环

`buildDriftCorrectionPrompt` 结尾（`DriftGate.ts:85`）：

> 如果你认为没有偏离，请用一句话说明理由再继续；否则按上述校正后推进。

执行者可以直接回一句「我认为没有偏离」然后继续做原来的事。**没有任何机制检查纠偏是否被采纳**——最近的检查点在 30 个 batch 之后，那时才由下一个 drift agent 从 `runHealth.driftCorrections` 推断"前几次纠偏无效"。

给执行者一个自我豁免的出口，在无人值守场景里是有风险的措辞：它把独立审查的结论降级为一次可选建议。

---

## 5. 产生的作用

| 关卡 | 通过时 | 不通过时 | 不可用时 |
| --- | --- | --- | --- |
| verify | 运行以 `success` 结束 | 注入 `buildVerifyRejectionPrompt`（未完成项 + 证据）、写 `verify_rejected` checkpoint、继续循环；5 轮用尽 → `verify_exhausted` | 默认 `checkpoint_pause` → 运行以 `auto_verify_unavailable` 停止（**fail-closed，正确**） |
| drift | 无操作（静默） | 注入 `buildDriftCorrectionPrompt`、写 `drift_corrected` checkpoint、继续 | 连续 3 次不可用 → `auto_drift_unavailable` 停止 |

这部分是健康的。特别值得肯定的两点：

- **fail-closed 是默认**（`KernelLoop.ts:713`）。`fail_open` 仅作为 legacy 兼容保留，注释明确标注。无人值守场景下"审核不可用"绝不等于"审核通过"，这个默认选对了。
- **双通道裁决**（`verdictChannel.ts`）。`return_result` 为主、末尾 JSON 块为备，并把两条通道同时写进 rubric，消除了历史上"注入的工具说要用工具、rubric 说要用文本"的自相矛盾。该文件的头部注释完整记载了这个 bug 的代价（每次重试是一次完整的 30 轮 / $1 / 30 分钟 judge 运行），是很好的工程记录。

---

## 6. ⚠️ 发现 7（中高·**已修复**）：drift 的轮询上限短于子代理自身寿命

> **状态：已于 2026-08-21 修复。** `resolveDriftLimits()` 现在与 `resolveJudgeLimits()`
> 对称地解析 `maxTurns` / `maxBudgetUsd` / `maxDurationMs`，显式传入 spawn 配置，
> 轮询上限改为 `maxDurationMs + 60_000`。新增 `timeouts.driftMaxDurationMs`、
> `META_AGENT_DRIFT_MAX_DURATION_MS`、`META_AGENT_DRIFT_MAX_TURNS`。
> 回归测试见 `core/__tests__/GateJudgeLimits.test.ts`。下文保留原始分析。

`VerifyJudge.ts:281`：

```ts
const MAX_WAIT_MS = limits.maxDurationMs + 60_000
```

注释解释得很清楚：「the ceiling outlasts the judge's own wall-clock cap so we always observe its terminal state rather than giving up early」。

`DriftAgent.ts:177`：

```ts
const MAX_WAIT_MS = 10 * 2 * 60 * 1000   // 20 分钟
```

而 `runDriftAgent` 的 spawn 配置里**根本没有传 `maxDurationMs`**（`DriftAgent.ts:145-172` 只传了 `maxTurns` / `maxBudgetUsd`），于是回落到 `DEFAULT_SUB_AGENT_MAX_DURATION_MS = 30 分钟`。

**20 分钟 < 30 分钟——正是 verify 明确修掉并写进注释的那个倒置。** 后果：

1. drift gate 在 20 分钟放弃轮询，把这次记为一次失败（累加 `consecutiveDriftGateFailures`，3 次就停整个运行）；
2. 与此同时那个子代理还会继续跑最多 10 分钟，烧掉预算，而它的裁决**已经没有人接收**；
3. 一个仅仅是"慢"的 drift agent 会被误判为"不可用"。

修法很小：给 drift 传显式 `maxDurationMs`，并把轮询上限改为 `maxDurationMs + 60_000`，与 verify 对齐。

---

## 7. 问题清单（按严重度）

| # | 严重度 | 问题 | 位置 |
| --- | --- | --- | --- |
| 1 | **高** | drift 的核心判据（completedSteps/note/artifacts）全部由被审查者自述，模块注释声称的"独立于执行者叙述"不成立 | `AgenticBackendFactory.ts:195`、`DriftAgent.ts:13` |
| 2 | **高** | verify 禁止运行 typecheck/test/lint，对"把构建跑绿"类目标护栏是 LLM 读代码；根因是 git 快照排除 gitignored 内容 | `VerifyJudge.ts:136`、`JudgeSnapshot.ts` |
| 3 | ~~中高~~ **已修复** | drift 轮询上限(20min) < 子代理寿命(30min，未显式传参)，慢 judge 被误判为不可用且继续空烧预算 | `DriftAgent.ts:177` vs `VerifyJudge.ts:281` |
| 4 | ~~中~~ **撤回** | 原写"drift rubric 硬编码工具列表会承诺不可用的 bash"——查证后不成立，见下方勘误 | `DriftAgent.ts:55` |
| 5 | 中 | `severity` minor/major 无任何行为差异，纯装饰 | `DriftGate.ts:75`、`Verdict.ts:91` |
| 6 | 中 | 纠偏无闭环，且 prompt 给了执行者自我豁免的出口 | `DriftGate.ts:85` |
| 7 | 中 | drift 节奏不可配置（`DRIFT_TURN_INTERVAL`）、不随轨迹自适应；`MAX_VERIFY_ROUNDS` 同样硬编码，而其余限额都可配 | `DriftGate.ts:24`、`VerifyGate.ts:24` |
| 8 | 低 | drift 直接写共享经验库绕过人工 review，README 未说明 auto 是该纪律的例外 | `AutoExperienceStore.ts:11` |
| 9 | 低 | drift `maxTurns: 30` 硬编码，verify 同类参数可经环境变量覆盖 | `DriftAgent.ts:145` |
| 10 | 信息 | 熔断退出（max_turns/budget/runtime）完全绕过 verify，运行只留下自述 checkpoint | `KernelLoop.ts:1463` |

---

## 8. 建议的处理顺序

**先做（小改动、高收益）：**

1. **修 #3**：drift 显式传 `maxDurationMs`，轮询上限对齐 verify。几行代码。
2. **修 #4**：把 `DRIFT_RUBRIC` 改成 `buildDriftRubric(allowedTools)`，照搬 verify 的做法。
3. **修 #1 的表层**：在 drift 的 task 里把改动清单提到 checkpoint **之前**，并把自述字段显式标注为"执行者自述，需交叉验证"。这是纯 prompt 改动，但直接改变 drift 的推理顺序——先看事实再看说法。

**接着（需要设计）：**

4. **处理 #2**，这是最有价值的一项。可行方向不是"让 judge 跑测试"（快照里跑不了），而是**把确定性检查交给执行者、把结果作为证据交给 judge**：auto 在 checkpoint 时记录最近一次构建/测试命令的退出码与输出摘要（确定性、零 LLM），verify 把它作为不可伪造的证据之一。这既绕开了快照的结构限制，也给 auto 补上了它目前完全缺失的确定性成分。
5. **决定 #5**：给 `major` 真实后果（建议：下次 drift 间隔减半），或删掉该字段。
6. **处理 #6**：至少在被判定 `major` 后缩短下次检查间隔，形成"纠偏→复查"的闭环。

**记录即可：**

7. #7 / #9 提为可配置项；#8 在 README 补一句说明 auto 是人工 review 纪律的例外及其理由。

---

## 9. 值得保留的设计

审查中确认写得好、不应在后续改动中被削弱的部分：

- **fail-closed 默认**。`checkpoint_pause` 而非 `fail_open`，且 legacy 选项被明确标注为兼容用途。
- **verify 的独立性构造**：纯目标 + 真实产物 + 强制举证 + 看不到执行者叙述。这是整套机制里最扎实的一环。
- **快照隔离**：独立 index 构建快照提交，不触碰执行者的真实 index / 工作树；judge 的 bash 写入落在一次性 worktree 里。
- **双通道裁决**及其头部注释——把一次昂贵故障的成因和修法完整记录下来，是这个代码库反复出现的好习惯。
- **`shared_readonly` 的真 enforcement**：工具过滤 + OS 沙箱只读 + 禁止无沙箱降级，三层都在。
