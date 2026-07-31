# Distill Intake 与语义复核收敛方案

状态：**已实施**（S1 + S2 + S3 全部）。§9 的四项取舍已于 2026-07-31 拍板，方向是
「先跑通、把严格性做成可观测而非可阻断」；每项都带复核触发条件，见 §9 表。实施记录见 §12。
日期：2026-07-31
上承：`docs/distill-semantic-severity-2026-07-28.md`（分级 + 执行落点）
关联落点：`src/loop/graph/distill/GraphDistiller.ts`、`DistillDesign.ts`、`DistillCheckpoint.ts`、
`src/loop/graph/spec/GraphLint.ts`、`src/loop/cli.ts`、`src/cli/index.ts`

---

## 1. 问题：一个现象，三个独立成因

现象是「用户给一份 `loop.md`，Distill 经常出不来图，卡在 semantic reviewer」。使用者的直觉描述是两条：
**每轮 reviewer 报的问题都不一样**，以及**它对路由审得过于严格细致**。

这两条感受背后是三个机制上互不相干的成因。它们必须分开修——07-28 的分级方案已经证明，把不同成因塞进同一个旋钮
（当时是「严重度」）只会在下一轮换个形式复发。

| 成因 | 机制 | 观察到的表现 | 修法 |
|---|---|---|---|
| **A 来源不完备** | `loop.md` 里的约束在自然语言层面就没有确定性 lower 的余地（单位无法换算、完成权未指定、依赖文件不存在） | `missing-source-bound`、`missing-precondition`、`capability` 反复 fail，且 Compiler 怎么改都改不好 | Intake 阶段（§3） |
| **B 裁决非幂等** | Reviewer 每轮从零重新推导一个**采样**的 finding 集合，宿主不持有跨轮 verdict | 每轮 finding 不同；修好第一批换来第二批 | verdict 棘轮 + 枚举式裁决（§4） |
| **C 路由复核过严** | `control_flow` 层的阻断类允许「无见证的判断」，且与确定性 lint 的边界没划干净 | 明明能跑的图被判不可达 / 无界 | 反例义务 + 可达性下沉 lint（§5） |

### 1.1 为什么 B 直接等价于「出不来图」

`GraphDistiller.ts:277` 的 `MAX_LOCAL_SEMANTIC_REPAIRS = 2`，配合 `:497`
`compilerAttemptLimit = maxAttempts + MAX_LOCAL_SEMANTIC_REPAIRS`，一次 run 的语义修复机会约为 3 轮。

Reviewer 的输出契约（`:916`）规定「每层最多 2 条 evidence」，且没有任何机制要求它**穷举**约束集合——
它每轮只报手上最扎眼的几条。于是「这一轮它没提 C7」与「这一轮它认为 C7 没问题」在宿主侧**不可区分**。

结果是：靶子每轮移动一次，而配额只允许移动三次。`formatAccumulatedSemanticErrors`（`:310`）
虽然把历轮 finding 都累积着喂回 Compiler，缓解了「修 A 破 B」的震荡，但它解决不了
「第 3 轮才第一次被告知 C9 有问题」——那时配额已经耗尽。

**B 不是体验问题，它是成功率的主项。**

### 1.2 A 的形态：不可修 finding，与 §8.5 同构

07-28 的 §8.5 识别过一类「改不好的 finding」：Architect 被要求把祈使语气的操作手册逐句抽成 hard
constraint，Compiler 却被禁止为阶段名伪造 Function，于是某些约束在设计上无路可走。执行落点
（`deriveEnforcementLocus`，`DistillDesign.ts`）把这条解决了。

但还剩一类同构的：**落点判对了，来源本身却给不出可 lower 的内容**。典型是 `missing-source-bound`——
来源写「最多执行 20 个有效候选轮次」，`kind=budget` → 落点 `graph`，判定正确；但「有效候选轮次」
与 Activation 之间没有任何来源给出的换算关系，Compiler 只能写 `maxTotalActivations=120` 然后被判
`missing-source-bound`。**没有人能修，因为缺的信息不在系统里。**

同类的还有：`success_criteria` 的核验标准没写死（reviewer 落点无从核验）、`capability` 缺口
（human 落点，只能问人）、首轮依赖的文件在项目里不存在（`missing-precondition`）。

这些约束的共同点是：**它们的缺口在任何 Graph 存在之前就已经确定，却要等到第 N 轮 Compiler
之后才由 Reviewer 发现。** 这是纯粹的反馈延迟浪费。

---

## 2. 设计原则（承接 07-28 的三条，追加两条）

07-28 已确立：
1. 严重度由宿主按 ruleClass 决定，不由模型自由裁量。
2. 一条规则只在一个地方查。
3. blocking 的判据是「跑不起来 / 跑飞 / 越权 / 明显没实现需求」，而非「不够好」。

本方案追加：

4. **缺口尽早暴露在唯一能补它的主体面前。** 来源缺失只有人能补，就不要让它在 Compiler 和
   Reviewer 之间来回三轮之后才浮现。
5. **复核结论跨轮单调，阻断结论必须有见证。** 已经通过且证据未变的约束不重新裁决；
   控制流类阻断必须给出宿主可机械校验的反例，给不出的自动降级为 advisory。

---

## 3. Intake：人机共创 Constraint Ledger

### 3.1 产物必须是 Ledger，不是「更完备的 loop.md」

直觉方案是让 meta-agent 与人一起把 `loop.md` 改好，再照旧跑 Distill。这个方向对，但产物形态选错了会
损失掉大部分收益：

- **散文进散文出。** 人确认过的东西到 Architect 阶段被重新解释一次。人以为自己敲定了「有效候选轮次 =
  一次 Worker Activation」，Architect 完全可能抽成另一个 constraint。人确认的效力在下一阶段蒸发。
- **`kind` 是整条链上杠杆最大的一个决定，而人从头到尾看不到它。** `deriveEnforcementLocus`
  从 `kind` 机械推 locus，locus 决定「什么算实现」（`DistillDesign.ts` 的 `ENFORCEMENT_LOCUS_BY_KIND`）。
  今天它由 Architect 一次性猜定，人要等到全流程通过、`loop.design.md` 落盘才第一次看见。
  一个把阈值路由标成 `recovery` 的误分类，会静默地让一条真实的硬边界落到 agent 落点上；
  反过来把领域判断标成 `deterministic_rule`，就制造一条永远修不好的 graph 落点 finding。
- **`intent_constraints` fail 是最贵的失败路径。** `GraphDistiller.ts:682` 的分支会
  `checkpoint.clear()` 并递归重跑整个 Architect。人确认过的 Ledger 恰好能让这条路径几乎不再触发。

所以 Intake 的一等产物是**人逐条确认过的 `LoopConstraintLedger`**，`loop.md` 的澄清附录是它的副产品。

### 3.2 探针题库由阻断枚举反查，不是开放式访谈

不要让 Intake Agent「自由发现漏洞」——那会把 B 类方差原样搬到更前面。题库应当直接从
**后面会真正阻断的那张表**反查：`BLOCKING_SEMANTIC_RULE_CLASSES`（12 条）加 error 级 lint 清单，
就是「这次 Distill 可能卡在哪」的完整枚举。

每条阻断类对应一个探针，且**先机械预检、只问真实缺口**：

| 阻断 ruleClass | Intake 探针 | 机械预检 | 人的回答落到 |
|---|---|---|---|
| `missing-source-bound` | 「来源写的『最多 N 个有效候选轮次 / 最长 T』：一个单位对应什么可观测事件？与 Activation 如何换算？」 | 扫来源中的数量词/时间词，逐个列出 | `constraint.acceptance` 写明换算式；`kind=budget\|deterministic_rule` |
| `single-agent-terminal-authority` | 「谁有权判定完成？固定标准是什么？Worker 自称完成算不算？」 | 检查来源是否出现独立评审角色 | 一条 `kind=success_criteria` 的约束 + 核验标准写进 `acceptance` |
| `missing-precondition` | 「首轮就要读的文件现在存在吗？外部 CLI / 凭据？」 | `glob`/`stat` 实地查、`command -v` 查 PATH | `preconditions.items`（file/directory/command/credential） |
| `fabricated-capability` | 「这一步需要的能力运行时有没有？」 | 比对 `graph_reference(capabilities)` 实际清单 | 有则 `kind=capability` 并入 preconditions；无则改设计 |
| `unbriefed-agent-constraint` | 「这条判断交给哪个角色？他需要读到什么才能判？」 | — | `constraint.sources` + Blueprint `lanes` |
| `writer-boundary-bypass` / `workspace_protocol` | 「最终产物文件有哪些？谁写？append 还是整体替换？允许多个生产者吗？」 | 列出项目现有产物文件 | `kind=workspace_protocol\|ownership` |
| `unbounded-or-unreachable-control` | 「什么条件下这个 loop 该停？失败了怎么办？人工介入点在哪？」 | — | `kind=terminal_obligation\|failure_boundary` |
| `constraint-weakened` | 「以下 N 条我标成了 hard，确认吗？」 | 列出全部 hard 约束供确认 | `strength` 逐条确认 |

`kind` 的确认单独走一轮：把每条约束的 `kind` 与由它推出的 locus 一起呈现给人
（「C7『每轮必须记录到 progress.md』→ workspace_protocol → 由 Graph 的 Lane 写规则强制」），
让人只判断这句话对不对。这比让人理解 12 个枚举值容易得多，且判错的代价立刻可见。

### 3.3 产物 schema

```ts
export const LOOP_INTAKE_SCHEMA = 'loop-intake-1.0' as const

export interface LoopIntakeProbe {
  /** 反查自哪条阻断类；用于回归统计「哪些探针真的在拦截失败」。 */
  ruleClass: typeof BLOCKING_SEMANTIC_RULE_CLASSES[number]
  question: string
  /** 机械预检结论；无预检时省略。 */
  precheck?: { kind: 'file' | 'command' | 'capability' | 'source-scan'; target: string; found: boolean }
  status: 'answered' | 'deferred' | 'not_applicable'
  answer?: string
  /** 该回答影响了 Ledger 的哪些条目。 */
  affects: string[]
}

export interface LoopIntakeRecord {
  schemaVersion: typeof LOOP_INTAKE_SCHEMA
  /** 与 DistillArchitectCheckpoint.source 同构，保证 loop.md 改动后 intake 自动失效。 */
  source: { requirement: string; projectDir: string; sha256: string }
  /** 人已逐条确认的约束台账。Architect 不再重新抽取，只校验并补 Blueprint。 */
  constraints: LoopConstraintLedger
  /** 人确认过 kind/strength 的 constraint id 集合。未在此列的按未确认处理。 */
  approvedConstraintIds: string[]
  /** Intake 阶段已能确定的启动前置条件（Compiler 仍可追加）。 */
  preconditions: LoopPreconditions
  probes: LoopIntakeProbe[]
  /** 人明确选择暂不解决的缺口；进入 preconditions 的 decision 项。 */
  deferred: Array<{ id: string; question: string; assumedDefault: string; affects: string[] }>
  completedAt: number
}
```

`source.sha256` 复用 `DistillCheckpoint.ts` 的 `sourceIdentity`：`loop.md` 一改，Intake 记录自动作废，
不会出现「人确认的是旧版需求」这种静默错配。

Intake 写出的每条约束设 `origin: 'intake'`（见 §3.4 的折中方案）。`approvedConstraintIds`
与 `origin` 的分工：前者是**人确认过 kind/strength 的**子集，后者标记**条目由谁产生**。
两者会重合但不等价——Intake 可以产出一条人没来得及逐条确认的约束（`/skip` 之后），
此时它 `origin='intake'` 但不在 `approvedConstraintIds` 里，Architect 对它有修改权。

### 3.4 与 Architect 的接口变化

Architect 从「抽取者」退化为「校验者 + Blueprint 生成者」：

```
无 Intake 记录（兼容路径）      有 Intake 记录（新路径）
────────────────────────      ────────────────────────
读来源 → 抽 Ledger → Blueprint   读 Intake.constraints → 校验一致性 → 只输出 Blueprint
```

具体改动：
- `DistillSource` 增加可选 `intake?: LoopIntakeRecord`；`loop/cli.ts` 的 `distill()`（`:91`）
  在 `projectDir` 下读 `loop.intake.json`，sha 匹配才注入。
- `buildLoopArchitectSystem()`（`:1090`）分两套任务描述。有 Intake 时按**折中方案**
  （已拍板 2026-07-31）明令：

  > Ledger 已由人逐条确认。你**可以追加**新条目——你是唯一读过项目现状的阶段，
  > 发现来源里没写、但项目现实要求的约束是你的职责；追加时必须设 `origin: "architect"`。
  > 你**不得**修改、删除或弱化任何 `origin: "intake"` 条目的 `statement`、`kind` 或 `strength`。
  > 若你认为某条已确认条目有误，把理由写进 `design.assumptions`，并照原样保留该条。

  取舍理由：Intake 阶段人不可能穷举，而 Architect 读了项目后确实可能发现真实缺口
  （典型是 `missing-precondition` 类：某个 Lane 要写的目录其实不存在）。禁止追加会把这些
  缺口重新推迟到 Reviewer 阶段，正好抵消 Intake 的收益。而人已确认条目的不可变性
  才是 Intake 的价值所在，必须保住。
- `LoopConstraint` 增加可选字段 `origin?: 'intake' | 'architect'`（缺省视为 `architect`，
  保持兼容路径不变）。`validateConstraintLedger`（`DistillDesign.ts`）在有 Intake 时追加一条
  机械校验：**每个 `approvedConstraintIds` 中的 id 都必须在新 Ledger 中存在，
  且其 `statement`/`kind`/`strength` 与 Intake 记录逐字节相同。** 不满足即 Architect 校验失败，
  走既有的 `formatArchitectValidationFeedback`（`:939`）重试路径。这条不靠提示词自觉，靠宿主强制。
- `intent_constraints` fail 的处理改变。`GraphDistiller.ts:682` 今天是递归重跑 Architect；
  有 Intake 时该分支改为**抛 `DistillIntakeGateError`**，把 finding 呈现给人，
  由人决定改 Ledger 还是改来源。理由：Ledger 已是人的意志，模型无权推翻它重抽一遍。
  注意这条只覆盖针对 `origin: 'intake'` 条目的 finding；若 finding 全部指向
  `origin: 'architect'` 的追加条目，仍走原来的递归重跑——那部分本来就是模型的产物。

### 3.5 CLI 形态

新增独立命令，不塞进 `distill` 内部——Intake 是有人参与的会话，与批处理的 Distill 生命周期不同：

```
meta-agent loop intake <requirement.md>     # 产出 loop.intake.json + 澄清附录写回 loop.md
meta-agent loop distill <requirement.md>    # 自动拾取同目录 sha 匹配的 loop.intake.json
meta-agent loop distill <req.md> --no-intake  # 强制走兼容路径
```

**Intake 默认可选，不强制（已拍板 2026-07-31）。** 没有 `loop.intake.json` 时 Distill 走今天的
兼容路径，行为不变。强制会让「改一个字重跑」这类正当用法变得昂贵，也会挡住已经很完备的来源。

代替强制的是**按需引导**——只在 Intake 真的能帮上忙的时刻提示，且提示要具体：

- Distill 失败退出时，若 fatal 里的 blocking finding 有任一条属于
  `missing-source-bound`/`missing-precondition`/`fabricated-capability`/`single-agent-terminal-authority`
  （即 §3.2 题库能覆盖的类别），在错误信息末尾追加一行：
  `这 N 条缺口需要来源补充信息，Compiler 无法自行修复。建议先运行：meta-agent loop intake <requirement>`。
  落点在 `GraphDistiller.ts:761` 的 fatal 拼装处，与既有的 `traceHint` 同级。
- 反过来，全部 finding 都是实现层的（`dangling-traceability`、`writer-boundary-bypass` 等）
  就**不要**提示 Intake——那是 Compiler 的问题，把人拉进来只是浪费时间。

Intake 会话形态复用 `runDistillSession`（`src/cli/index.ts:5354`）的交互骨架：逐条呈现探针、
接受自由文本回答、`/skip` 记入 `deferred`、`/show` 查看当前 Ledger、`/done` 落盘。
Intake Agent 的 `allowedTools` 为 `['read_file','grep','glob','ask_user']`——与 Architect 同权限，
不需要新增工具面。

`GraphDistillPhase`（`ForegroundGraphDistillExecutor.ts:4`）增加 `'intake'`，
`GRAPH_DISTILL_PHASE_POLICY`（`:246`）补一档预算。Intake 是长会话，
建议 `maxTurns: 60 / thinkingBudgetTokens: 8_000 / maxOutputTokens: 32_768`。

---

## 4. 复核方差治理

Intake 不解决 B。以下三条独立于 §3，可先行落地。

### 4.1 verdict 棘轮（宿主侧跨轮单调）

宿主为每条 hard constraint 保存跨轮 verdict。上一轮 `pass` 的约束，**除非它的 graphRefs 所覆盖的
图区域在本轮被改动过**，否则本轮直接沿用 pass，不进 reviewer 的复核范围。

```ts
interface ConstraintVerdict {
  constraintId: string
  verdict: 'pass' | 'fail'
  /** 作出该结论时所依据的图区域指纹。 */
  evidenceHash: string
  ruleClass?: SemanticRuleClass
  decidedAtCompilerAttempt: number
}

/** 只有被改动过的证据区域才需要重新裁决。 */
function staleVerdicts(
  ledger: ConstraintVerdict[], traceability: GraphTraceabilityMap, graph: LoopGraphSpec,
): Set<string> {
  const stale = new Set<string>()
  for (const verdict of ledger) {
    const refs = traceability.mappings.find(m => m.constraintId === verdict.constraintId)?.graphRefs ?? []
    if (hashPointerRegions(graph, refs) !== verdict.evidenceHash) stale.add(verdict.constraintId)
  }
  return stale
}
```

`hashPointerRegions` 对每个 JSON pointer 解引用后规范化序列化再取 sha256；指针本身消失也算变更。
这是纯确定性计算，无模型参与。

注入 reviewer 的新段落：

```
【本轮复核范围（宿主判定）】
以下约束在上一轮已核验通过，且其 graphRefs 覆盖的图区域本轮未改动，不要重新裁决，也不要为它们
产出 finding：C1, C3, C4, C8…
本轮需要裁决：C7（上轮 fail）、C11（graphRefs 区域本轮变更）、C15（本轮新增 mapping）。
```

**收益**：靶子不再移动。第 2 轮只可能报「上轮已知的 C7」和「本轮改动引入的新问题」，
后者是真实的回归，值得阻断。

**已拍板（2026-07-31）：不做全量兜底复核。** 棘轮结论一经作出即终局，接受候选前不再做一次
不带棘轮的完整裁决。

代价是明确的：本轮修改可能破坏一条 graphRefs 未变的约束（典型是改了 `/limits` 或
`/concurrency` 却只影响到指向 `/nodes/x` 的那条），棘轮会让它逃逸。接受这个代价的理由是
——当前的绑定约束是「出不来图」而不是「出了错图」，而全量兜底恰好把成本加在最关键的最后一轮上。

不做兜底，就必须把漏判做成**可观测**而不是不可见：

- `hashPointerRegions` 的指纹**不只覆盖 mapping 的 graphRefs**，额外把三个全局区域并入每条指纹：
  `/limits`、`/concurrency`、以及该约束 graphRefs 所涉节点的 Lane 定义。这三处是「改一处影响一片」
  的已知来源，代价只是让它们的改动使全部 verdict 失效一轮——这正是想要的行为。
- 每次沿用棘轮结论时向 trace 落一条 `verdict_carried` 记录（constraintId、沿用自哪一轮、指纹）。
  实跑一段时间后可以离线重放，统计「若当时做了全量复核，会有多少条被推翻」，用数据决定
  要不要把兜底加回来。

### 4.1.1 指纹的保守读法

指纹不匹配一律按「需要重新裁决」处理，包括指针消失、指针指向的值变成 `null`、
以及 traceability 中该约束的 mapping 整条不见。**任何不确定都倒向重审**，这是不做兜底之后
唯一还剩的安全边。

### 4.2 采样改枚举：`loop-semantic-review-2.2`

Reviewer 的输出契约增加一张**每条 hard constraint 一行**的裁决表。这直接消灭
「没提 = 通过？」的歧义：

```ts
export const SEMANTIC_REVIEW_SCHEMA = 'loop-semantic-review-2.2' as const

export interface ConstraintVerdictRow {
  constraintId: string
  /** 落点由宿主注入，模型只回填裁决，不得改写。 */
  verdict: 'satisfied' | 'violated' | 'out_of_scope'
  /** violated 时必填，且必须取自枚举。 */
  ruleClass?: SemanticRuleClass
  /** satisfied 时指向实现处；violated 时指向缺陷处。out_of_scope 可空。 */
  graphRefs: string[]
}

export interface LayeredSemanticReview {
  schemaVersion: typeof SEMANTIC_REVIEW_SCHEMA
  accepted: boolean                       // 宿主计算
  /** 必须覆盖本轮复核范围内的每一条 hard constraint，不得缺行。 */
  verdicts: ConstraintVerdictRow[]
  layers: Record<SemanticReviewLayer, { … }>   // 结构不变，用于层级证据与 advisory
  issues: string[]
  advisories: string[]
}
```

宿主侧校验：`verdicts` 缺行 → 整份裁决作废并重试（复用 `reviewGraphSemantics` 的
`maxReviewAttempts = 2`，`:780`）。这条是硬的——枚举契约的全部价值就在于「不缺行」。

**`out_of_scope` 先按宽松读法落地（已拍板 2026-07-31）。** 原设计是「`graph`/`reviewer`
落点填 `out_of_scope` 一律按 `violated` 处理」。先不上这条严格判定，理由是它与本方案的主目标
（提高成功率）方向相反，且在没有实跑数据之前无法判断有多少 `out_of_scope` 是正当的
——例如一条 `kind=event` 的约束，来源其实描述的是 Agent 轮内轮询，此时越界标注是对的。

宽松读法的具体规则：

- `out_of_scope` 不计入 blocking，不影响 `accepted`。
- 但**必须带 `justification`**（一句话说明为什么这条约束不适用于 Graph 层核验），
  且宿主把「落点 ∈ {graph, reviewer} 且 verdict = out_of_scope」的每一行记入 trace 的
  `out_of_scope_escape` 事件，连同 constraintId、kind、推导出的 locus 和 justification。
- 该记录同时以 advisory 形式进入 `advisories`，这样它在 `printDistillDraft`
  （`src/cli/index.ts:5729`）里对人可见——不阻断，但不静默。

```ts
export interface ConstraintVerdictRow {
  constraintId: string
  verdict: 'satisfied' | 'violated' | 'out_of_scope'
  ruleClass?: SemanticRuleClass          // violated 时必填
  justification?: string                 // out_of_scope 时必填
  graphRefs: string[]
}
```

积累一段 trace 后回看：如果 graph/reviewer 落点的 `out_of_scope` 比例低且理由多数成立，
保持宽松；如果它变成放行通道（比例高、理由空泛、且这些约束在运行期真的没被实现），
再按原设计上严格判定。这条明确留作 §9 的复核项。

**输出规模**：一行约 40–80 token（带 justification 的行更长，但只是少数）。30 条 hard
constraint 约 1.5–2.5K token，配合棘轮后每轮实际只需完整推理 delta 集合，
`maxOutputTokens: 16_384`（`:268`）够用。

### 4.3 lint warning 的注入收敛

`GraphDistiller.ts:800` 把**全部** warning 级 lint 注入 reviewer，并要求
「每条都必须在对应层给出核验证据，不得忽略」（提示词 `:894`）。

问题在于 warning 集合每轮随图变化。图一改，reviewer 就换来一批新的必答题——
**这是 B 类方差最直接的放大器，且它是宿主亲手灌进去的。**

改法：
- 只注入与本轮复核范围（§4.1）相关的 warning，即其 `at` 指向的节点/Lane/Transition
  出现在待裁决约束的 graphRefs 中。
- 提示词从「每条都必须给出核验证据」改为「以下提示与本轮待裁决约束相关，
  可用于定位；核验不成立才提 finding，成立则无需为它单独产出 evidence」。
- `single-agent-terminal-authority` 已经是 warning 级 lint（`GraphLint.ts:863`）**又是**阻断级
  semantic ruleClass。按原则 2，二者择一：建议保留 semantic 侧（它需要判断「独立性」，
  lint 只能看拓扑），把 lint 侧降为纯 `at` 定位提示，不进 reviewer 必答题。

### 4.4 三条的联合效果

| | 今天 | 落地后 |
|---|---|---|
| 第 2 轮可能报的 finding | 任意子集，含第 1 轮没提的旧问题 | 仅「第 1 轮 fail 的」+「本轮改动引入的」 |
| 「没提」的含义 | 不可区分 | 明确等于 `satisfied` |
| 每轮必答的 lint 题 | 全量 warning，随图变化 | 与待裁决约束相关的子集 |
| 收敛所需轮次 | 与约束数同阶 | 与真实缺陷数同阶 |

---

## 5. 路由复核降噪

### 5.1 阻断级 control_flow finding 必须附反例

`unbounded-or-unreachable-control`、`missing-source-bound`、`state-routing-divergence`
今天允许「读了图之后认为不对」。这三类恰好是假阳性最集中的地方，因为它们要求 reviewer
从自然语言推真值表（07-28 §6 已记录过同类担忧）。

新增结构约束：这三类 finding 必须携带宿主可机械校验的反例。

```ts
export interface ControlFlowWitness {
  /** 初始 State 赋值；键必须是 graph.state 中真实存在的字段。 */
  state: Record<string, JsonValue>
  /** 触发序列；每项必须是 graph.transitions 中真实存在的 id。 */
  path: string[]
  /** 该序列导致的后果，与 ruleClass 对应。 */
  outcome: 'terminal_unreachable' | 'bound_exceeded' | 'route_uncovered' | 'stale_state_read'
}
```

宿主校验：`state` 的每个键在 `graph.state` 中存在且类型相容；`path` 的每个 id 在
`graph.transitions` 中存在且首尾相接。**校验失败或缺失 witness，该 finding 自动降级为 advisory。**

理由：真实的终态不可达、真实的上限突破，一定存在一条具体的见证路径；
「我觉得这里不够严谨」没有。这条不削弱任何真实的安全性，只削弱猜测。

不对 `writer-boundary-bypass`、`annotation-only-satisfaction` 等施加同样要求——
它们是结构性判断，不是路径判断。

### 5.2 可达性下沉为确定性 lint

`unbounded-or-unreachable-control` 的判据里有一半是**纯图算法**：

- 终态从 entrypoints 可达性 → 有向可达性，可精确判定。
- 非终态 outcome 全覆盖 → `GraphLint.ts:461` 的 `route-partition-gap` 已覆盖一部分。

新增 lint 规则 `terminal-unreachable`（error 级）：从 `entrypoints` 出发做可达性闭包，
任何 `type:'terminal'` 节点不在闭包内即报错。这不需要求解 `when` 条件——
把每条 Transition 都当作可能触发，得到的是**可达性上界**；上界都到不了的终态，
一定真的到不了，零假阳性。

落地后按原则 2，从 reviewer 提示（`:861` 的第 4 层与阻断条目）删去「终态不可达」这半边，
`unbounded-or-unreachable-control` 只保留「无界运行」与「恢复路径不闭合」，
且这两条都受 §5.1 的反例义务约束。

### 5.3 提示词对应改动汇总

`buildGraphSemanticReviewerSystem()`（`:861`）：

- 新增【本轮复核范围】段（§4.1）。
- 新增【裁决表】输出要求（§4.2）。
- 新增【反例义务】段（§5.1）：明确「拿不出反例的控制流判断请填 advisory 的
  `threshold-truth-table` 或 `branch-priority`，不要填阻断类」。
- 【已由确定性 Lint 拥有，不要复查】清单追加 `terminal-unreachable`。
- 【机械 Lint 提示】段的措辞从「必须逐条核验」改为「相关提示，可用于定位」（§4.3）。

`buildLoopArchitectSystem()`（`:1090`）：新增有 Intake 时的分支（§3.4）。

`buildGraphDistillerSystem()`（`:1126`）：无需改动。Compiler 收到的诊断格式不变，
只是数量减少、跨轮稳定。

---

## 6. Schema 变更汇总

| Schema | 变更 |
|---|---|
| `loop-intake-1.0` | **新增**。`LoopIntakeRecord`（§3.3） |
| `loop-constraints-2.0` | `LoopConstraint` 增加**可选** `origin?: 'intake' \| 'architect'`（决定 4）。可选即向后兼容，`schemaVersion` 不动——兼容路径下所有条目缺省为 `architect`，语义与今天一致 |
| `loop-semantic-review-2.1 → 2.2` | 新增 `verdicts: ConstraintVerdictRow[]`（含 `justification?`，决定 2）；`findings` 增加可选 `witness: ControlFlowWitness` |
| `loop-preconditions-1.0` | 不变。Intake 直接产出同形状对象，Compiler 的 `mergeUnresolvedIntoPreconditions`（`:1390`）继续合并 |
| `distill-architect-checkpoint-1.0` | 不变 |

`loop-semantic-review-2.1` 的读兼容：`readDistillArtifacts`（`:91`）遇到 2.1 时把
`verdicts` 视为 `[]`，仅用于展示历史产物，不参与新的判定。

---

## 7. 落点表

| 改动 | 文件 | 位置 |
|---|---|---|
| `ConstraintVerdict` / `hashPointerRegions` / `staleVerdicts` | `DistillDesign.ts` | 新增导出 |
| verdict 台账贯穿 compiler 循环 | `GraphDistiller.ts` | `:484` `semanticHistory` 旁 |
| 复核范围注入 reviewer | `GraphDistiller.ts` | `:788` `reviewGraphSemantics` 的 taskDescription |
| ~~最后一轮全量复核~~ | — | **不做**（决定 1） |
| `verdict_carried` / `out_of_scope_escape` trace 事件 | `GraphDistiller.ts` | `:644` 接受路径与 `:656` 拒绝路径，经 `deps.trace.event` |
| lint warning 相关性过滤 | `GraphDistiller.ts` | `:800` |
| `verdicts` 解析、缺行作废、`justification` 必填 | `GraphDistiller.ts` | `parseLayeredSemanticReview` `:1406` |
| witness 机械校验 | `GraphDistiller.ts` | `parseSemanticFindings` `:1464` |
| `origin` 字段与已确认条目不可变校验 | `DistillDesign.ts` | `LoopConstraint` / `validateConstraintLedger` |
| A 类 finding 触发 Intake 引导 | `GraphDistiller.ts` | `:761` fatal 拼装处，与 `traceHint` 同级 |
| `terminal-unreachable` lint | `GraphLint.ts` | 新规则，error 级 |
| `single-agent-terminal-authority` 退出必答题 | `GraphLint.ts` / `GraphDistiller.ts` | `:863` / `:800` |
| Intake 阶段与 phase policy | `ForegroundGraphDistillExecutor.ts` / `GraphDistiller.ts` | `:4` / `:246` |
| `loop intake` 命令 | `src/loop/cli.ts` | `:60` 的 switch |
| Intake 交互会话 | `src/cli/index.ts` | `runDistillSession` `:5354` 附近 |
| Intake 记录拾取 | `src/loop/cli.ts` | `distill()` `:91` |

---

## 8. 实施排期

| 阶段 | 内容 | 为什么这个顺序 |
|---|---|---|
| **S1** | §4.1 棘轮 + §4.2 枚举裁决 + §4.3 lint 收敛 + §11.1 的 trace 统计脚本 | 改动局限在 `GraphDistiller.ts` + `DistillDesign.ts`，不动 Distill 拓扑、不动 CLI、不动产品面。直接打 B 类——当前成功率的主项。统计脚本与棘轮**同批交付**：决定 1、2 都是「用可观测性换严格性」，观测缺席就等于两个决定都没生效 |
| **S2** | §5.1 反例义务 + §5.2 `terminal-unreachable` lint | 同样是内部改动。打 C 类。放在 S1 后是因为 S1 的 trace 能量化 C 类到底占多少 |
| **S3** | §3 Intake 全套 | 产品面改动（新命令、新交互、新产物）。题库现在就能从阻断枚举生成，但值得先用 S1/S2 的 trace 数据确认 A 类的真实占比再投入 |

S1 与 S2 都可以用现有 `.loop/distill/run-*/` 的 trace 目录直接回归：
`review.r*.c*.json` 保存了完整的分层裁决，可以离线重放，统计
「同一条约束在不同轮次的 verdict 是否翻转」和「有多少 control_flow 阻断给不出反例」。

---

## 9. 已拍板的取舍（2026-07-31）

四项全部定稿。共同倾向是**先让流程跑通，把严格性做成可观测而不是可阻断**——当前的绑定约束
是「出不来图」，不是「出了错图」。每一项都留了明确的复核触发条件，不是永久决定。

| # | 取舍 | 决定 | 落在 | 复核触发条件 |
|---|---|---|---|---|
| 1 | 棘轮的兜底强度 | **不做全量兜底复核** | §4.1 | `verdict_carried` trace 离线重放显示「若做全量会被推翻」的比例 > 5% |
| 2 | `out_of_scope` 的宽严 | **先宽松**：不计入 blocking，但必须带 `justification` 并记 trace + advisory | §4.2 | graph/reviewer 落点的 `out_of_scope` 占比偏高，或抽查发现理由空泛 |
| 3 | Intake 是否强制 | **默认可选**，仅在失败 finding 属于 A 类题库时按需引导 | §3.5 | 引导提示的采纳率过低（人看到也不用），说明引导时机或措辞选错 |
| 4 | Architect 可否补充 Ledger | **折中**：可追加（`origin:'architect'`），不可改动 `origin:'intake'` 且已确认的条目 | §3.4 | Architect 追加条目在 Reviewer 处的 fail 率显著高于 Intake 条目，说明追加权被滥用 |

### 9.1 四项决定的共同代价

1、2 两项都把「可能的漏判」换成了「更快出图」。它们叠加起来有一个共同的失效模式值得单独写出来：
**一条约束在第 1 轮被判 `out_of_scope`（宽松放行），棘轮把它固化，且没有全量兜底把它捞回来。**

这条路径下该约束从头到尾没被真正核验过，却也不会有任何东西报错。三道防线是：

- `out_of_scope` 必须带 `justification`，且 graph/reviewer 落点的每一次都进 trace 与 advisories
  ——它在 `printDistillDraft` 里对人可见（§4.2）。
- 棘轮沿用时落 `verdict_carried`，指纹里包含了 `/limits`、`/concurrency` 与相关 Lane（§4.1）。
- 两类记录都可离线重放。**§11 的验证清单必须把「out_of_scope 且被棘轮沿用」列为一个单独的
  统计项**——这是本方案自己制造的唯一新盲区，不统计它就等于没有决定过它。

### 9.2 明确不做的事

- 不做「接受前全量复核」（决定 1）。
- 不做「graph/reviewer 落点的 `out_of_scope` 自动转 violated」（决定 2）。
- 不做「Intake 强制」，也不做「Distill 在无 Intake 时降级或警告」（决定 3）——
  兼容路径的行为必须与今天逐字节一致，否则无法用它做 A/B。
- 不做「Architect 完全只读 Ledger」（决定 4）。

---

## 10. 残余风险

- **棘轮把一次采样固化成结论，且没有兜底。** 决定 1 之后，第 1 轮的 `pass` 若本身是漏判，
  棘轮会让它一直漏到底；本轮修改间接破坏一条 graphRefs 未变的约束，也不再有全量复核捞回来。
  §4.1 的指纹扩容（并入 `/limits`、`/concurrency`、相关 Lane）覆盖了最常见的间接破坏，
  但不是完备的。这是用确定性换取收敛速度的自觉代价，与 07-28 §8 接受
  「模型可能误分类 ruleClass」同性质——差别是这次的代价被记进了 trace，可以事后量化。
- **`out_of_scope` 是一条被有意留开的放行通道。** 决定 2 之后，模型把一条 graph 落点的硬约束
  标成「不适用」就能绕过阻断，宿主只记录不拦截。缓解是 `justification` 必填 + advisory 可见 +
  trace 可统计，威慑而非阻断。这条与棘轮叠加的复合盲区见 §9.1。
- **枚举裁决可能诱发敷衍。** 要求每条都给 verdict，模型可能批量填 `satisfied` 以省 token。
  缓解：`satisfied` 必须带非空 `graphRefs` 且指针必须存在（宿主机械校验，复用
  `validateGraphTraceability` 的 `jsonPointerExists`）。填不出指针就填不了 `satisfied`。
  注意这条缓解在决定 2 之后更重要了——`satisfied` 有指针门槛而 `out_of_scope` 没有，
  敷衍的最省力路径会从 `satisfied` 转移到 `out_of_scope`。这正是要统计后者占比的原因。
- **Architect 的追加权可被用作绕道。** 决定 4 允许追加 `origin:'architect'` 条目。
  模型无法修改人已确认的条目，但可以追加一条语义相近、strength 更弱的新条目来「稀释」它。
  宿主拦不住这种行为（追加本身是合法的），只能靠 Reviewer 的 `constraint-weakened` 类捕捉，
  以及 §9 表中「追加条目 fail 率」这一复核指标。
- **Intake 把工作量转移给人。** 这是设计意图而非副作用——A 类缺口本来就只有人能补。
  但如果探针问得太碎，人会放弃。所以题库必须先机械预检、只问真实缺口，
  且 `/skip` 必须是一等操作（落到 `deferred` → `preconditions.decision`，
  由 `loop create` 在启动前再拦一次），而不是逼人当场回答。
- **反例义务可能被伪造。** 模型可以编一条语法合法但语义无关的 `path`。
  宿主只校验 id 存在与首尾相接，不校验语义。但伪造一条合法路径的成本高于直接填 advisory，
  且伪造痕迹会留在 trace 里可被统计。

---

## 11. 验证方式

- **离线回归**：以现有 `.loop/distill/run-*/review.r*.c*.json` 为夹具，
  实现棘轮后重放，断言「跨轮 verdict 翻转次数」显著下降。
- **合成用例**：构造一张已知终态不可达的图，断言 `terminal-unreachable` lint 命中且
  reviewer 不再重复报告；构造一张终态可达但 reviewer 曾误判的图，
  断言在反例义务下该 finding 降级为 advisory。
- **端到端**：以 `docs/examples/x1_loop.md`，以及 07-28 文档中记录过 C18 失败的那份 F1 需求
  （`f1_loop.md`，在用户项目内、不在本仓库）为输入各跑 5 次，
  记录成功率、语义轮次数、reviewer 总 token。S1 的目标是**轮次数下降**，
  S3 的目标是**成功率上升**，两者不要混在同一个指标里看。
- 全量 `vitest run` 与 `tsc --noEmit` 保持通过；新增测试至少覆盖：
  棘轮失效判定 3 例（含 `/limits` 改动使全部 verdict 失效）、`verdicts` 缺行作废 2 例、
  `out_of_scope` 缺 `justification` 作废 1 例、witness 校验 3 例、`terminal-unreachable` 3 例、
  已确认条目被改动时 Architect 校验失败 2 例。

### 11.1 决定 1/2 制造的盲区，必须单独统计

§9.1 指出「`out_of_scope` 放行 + 棘轮固化」是本方案自己引入的唯一新盲区。不统计它，
就等于没有做过这两个决定。落地时必须同时交付一个离线分析脚本，从 `.loop/distill/run-*/`
读出并输出四个数：

| 指标 | 口径 | 判读 |
|---|---|---|
| `carried_ratio` | `verdict_carried` 条数 ÷ 全部约束轮次数 | 高说明棘轮在起作用（预期效果） |
| `would_have_flipped` | 重放时对沿用结论做一次补充裁决，结果与沿用值不同的比例 | > 5% 则按 §9 表触发决定 1 的复核，把兜底加回来 |
| `oos_ratio` | graph/reviewer 落点的 `out_of_scope` ÷ 该落点全部行数 | 偏高说明放行通道被当成省力路径 |
| `oos_carried` | 既是 `out_of_scope` 又被棘轮沿用的约束条数 | **这是复合盲区的直接计数，理想值为 0；非 0 时逐条人工看** |

`would_have_flipped` 需要额外的 reviewer 调用，因此它是**离线抽样**指标，不进 CI；
其余三个是纯 trace 统计，可以每次 run 后自动算出来打印在 `loop distill` 的结尾。

---

## 12. 实施记录（2026-07-31）

| 项 | 状态 | 落点 |
|---|---|---|
| §4.1 verdict 棘轮 | 已实施 | `DistillDesign.ts`：`ConstraintVerdict` / `hashPointerRegions` / `staleVerdicts` / `canonicalJson`；`GraphDistiller.compileLoopGraph` 持 `verdictLedger`，每轮算 carried 与 reviewScope |
| §4.1 指纹扩容 | 已实施 | `hashPointerRegions` 并入 `/limits`、`/concurrency` 及 graphRefs 所涉节点的 Lane；指针消失、mapping 消失均按需重审 |
| §4.1 不做全量兜底 | 按决定 1 执行 | 接受路径无二次复核；改为落 `verdict_carried` trace 事件 |
| §4.2 枚举裁决 | 已实施 | schema 升 `loop-semantic-review-2.2`；`ConstraintVerdictRow`；`parseConstraintVerdicts` 缺行作废、`satisfied` 需可解析指针、`out_of_scope` 需 `justification` |
| §4.2 `out_of_scope` 宽松 | 按决定 2 执行 | 不阻断；graph/reviewer 落点每次使用落 `out_of_scope_escape` trace 并写入 `advisories`（在 `printDistillDraft` 可见） |
| §4.3 lint 收敛 | 已实施 | `selectRelevantLintWarnings` 按 reviewScope 的 graphRefs 锚点过滤；reviewer 提示从「逐条必答」改为「供定位」；`single-agent-terminal-authority` 退出必答题（语义侧保留） |
| §5.1 反例义务 | 已实施 | `ControlFlowWitness` / `validateControlFlowWitness` / `WITNESS_REQUIRED_RULE_CLASSES`；`demoteUnwitnessedFinding` 把无效反例的阻断改判为新增建议级 `unwitnessed-control-flow`，并把只剩建议的 `fail` 层归正为 `pass` |
| §5.2 可达性下沉 | 已实施 | `GraphLint.lintUnreachableTerminals`（error 级 `terminal-unreachable`，忽略 `when` 取可达性上界，零假阳性）；reviewer 提示的「已由 Lint 拥有」清单同步追加 |
| §3 Intake | 已实施 | 新增 `DistillIntake.ts`（`loop-intake-1.0`、题库、store、提示词、解析）；`GraphDistillPhase` 增 `intake` 与预算档；`loop intake` 命令；`distill` 自动拾取且支持 `--no-intake` |
| §3.4 折中方案 | 按决定 4 执行 | `LoopConstraint.origin`（可选，缺省 `architect`）；`validateIntakeLedgerPreservation` 机械校验已确认条目不可变、允许追加；Architect 提示分双路径 |
| §3.4 intent gate | 已实施 | `DistillIntakeGateError`：finding 命中人已确认条目时停下问人；只涉及 `origin:'architect'` 追加条目时仍走原递归 |
| §3.5 按需引导 | 按决定 3 执行 | `intakeGuidanceForIssues` 仅在 blocking finding 属于来源侧类别时追加建议，接在 fatal 的 `traceHint` 之后 |
| §11.1 盲区统计 | 已实施 | 新增 `DistillTraceStats.ts`；`loop distill` 结尾打印 `carried / carriedRatio / oosEscapes / oosCarried / unwitnessedDemotions`，`oosCarried > 0` 直接给出人工复核警告 |

与设计文档的两处偏差，均为实施中发现后从严处理：

1. **降级不是复用既有 advisory 类，而是新增 `unwitnessed-control-flow`。** 文档原写「填 threshold-truth-table 或 branch-priority」，
   但那会把「阈值推导不精确」和「拿不出反例」混成同一个统计口径，事后无法分辨。新增专用类后 §11.1 的
   `unwitnessedDemotions` 才是可信的。
2. **witness 的合法性检查在有图时才做，无图时只检查"有没有"。** `parseLayeredSemanticReview` 可以被不带 graph 的调用方使用（单测、
   仅校验形状）。缺失 witness 与否不依赖图，照常降级；结构是否成立则不拿宿主自己的信息缺失去惩罚 reviewer。

验证：`tsc --noEmit` 通过；`vitest run` 全量 **172 文件全部通过**。新增 `DistillReviewConvergence.test.ts` 共 23 例，覆盖
棘轮沿用/失效（含 `/limits` 与 Lane 改动使全部 verdict 失效、mapping 消失、键序不影响指纹）5 例、
枚举裁决缺行与 `satisfied` 指针门槛 5 例、`out_of_scope` justification 1 例、反例义务 5 例、
`terminal-unreachable` 4 例、Intake 台账不可变 3 例、盲区统计 1 例。

`DistillCheckpoint.test.ts` 的 `rejectedReview` 夹具同步升级：控制流类 ruleClass 自动附带合法 witness，
使既有的「跨轮累积」用例继续测累积本身，而不是意外走进降级路径。
