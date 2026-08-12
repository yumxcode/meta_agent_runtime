# Distill 语义复核分级方案（2b 白名单草案）

状态：**已实施**（方案 1 + 表 A + 表 B/C）。第 6 节的取舍仍待实跑数据验证；方案 2c 未做。
日期：2026-07-28
关联：`src/loop/graph/distill/GraphDistiller.ts`、`src/loop/graph/distill/DistillDesign.ts`、
`src/loop/graph/distill/DistillTrace.ts`、`src/loop/graph/spec/GraphLint.ts`

---

## 1. 问题

当前 `LayeredSemanticReview` 没有严重度概念：

```ts
// DistillDesign.ts:119-129
layers: Record<SemanticReviewLayer, {
  status: 'pass' | 'fail' | 'not_applicable'
  evidence: Array<{ sourceRefs; designRefs; graphRefs; statement }>
  issues: string[]        // 无级别
}>
```

任一层 `fail` → `accepted=false` → Distill 失败。系统提示 `GraphDistiller.ts:689` 进一步明令
「warnings 必须始终为 []」，`parseLayeredSemanticReview:1046` 用 `if (warnings.length) continue`
机械兜底。结果是一个全有全无的准入门。

对照机械 lint（`GraphLint.ts:19`）反而有 `level: 'error' | 'warning'` 两级，且
`GraphDistiller.ts:452-455` 只让 error 级阻断。**确定性最强的检查有分级，方差最大的
LLM 复核反倒没有。**

## 2. 设计原则

1. **严重度由宿主按 ruleClass 决定，不由模型自由裁量。**
   `GraphDistiller.ts:689` 那条禁令有来历——历史上 reviewer 把硬约束不符降级成 warning
   然后放行。新方案下模型只能从固定枚举里选 `ruleClass`，`accepted` 由宿主计算。
2. **一条规则只在一个地方查。** 确定性可判定的归 lint，机器证明不了的归 reviewer，
   不允许两边都查。
3. **blocking 的判据是「图跑不起来 / 跑飞 / 越权 / 明显没实现需求」**，
   而非「不够好」。

---

## 3. 表 A — 移交 lint（从 reviewer 提示中删除）

这些当前在 reviewer 系统提示里，但都是确定性可判定的，且多数 lint 已经在查——属于重复劳动
且徒增采样方差。

| reviewer 条目 | 出处 | 对应 lint 规则 | lint 现状 |
|---|---|---|---|
| 写入须被所属 Lane.workspace.write 覆盖 | `:673` | `undeclared-workspace-write` | error，已有 |
| 项目外写 / 绝对路径 / `~` | `:667` | `outside-project-write`、`absolute-path` | error，已有 |
| `lane.scm='git'` 权限升级须有对应能力 | `:663` | `git-without-capability` | error + warning，已有 |
| 每个 agent `budget.wallTimeMs` ≥ 300000 | `:687` | `agent-budget-walltime` | error，已有 |
| 不得仅因角色名/first-run/独立 budget 拆 Agent | `:685` | `same-lane-agent-split` | warning，已有 |
| 不同 Lane 写路径不得重叠 | `:664` | — | **需新增 error** |
| 不得为建父目录额外 `bash mkdir` / 扩大成 owned | `:675` | — | **需新增 warning** |

净效果：reviewer 提示可删掉约 5 段，同时补 2 条 lint 规则。

---

## 4. 表 B — blocking 白名单（10 条）

任一条命中即 `accepted = false`，Distill 不得产出。

| ruleClass | 层 | 判据 | 来源条目 |
|---|---|---|---|
| `unimplemented-hard-constraint` | intent_constraints | 来源 hard constraint 在 Ledger/Blueprint 中漏记，或图中找不到任何实现 | `:669` |
| `constraint-weakened` | intent_constraints | 目标、成功标准或 hard/soft 强度被改写、弱化 | `:662` |
| `dangling-traceability` | capability_resolution | hard constraint 的 `graphRefs` 指向最终图中不存在的 JSON pointer | `:666` |
| `fabricated-capability` | capability_resolution | 引用了 `graph_reference(capabilities)` 中不存在的 Tool / Function / Reducer / Effect / Pack | `:666` |
| `annotation-only-satisfaction` | capability_resolution | hard constraint 仅靠 annotations / taskSpec / rationale 满足；或 Agent prompt 依赖 annotations 中的值 | `:673` |
| `unbounded-or-unreachable-control` | control_flow | 无界运行、终态不可达、非终态 outcome 未全覆盖、恢复路径不闭合 | `:665` |
| `missing-source-bound` | control_flow | 来源声明的轮次 / 时长 / 次数上限在图中没有对应的确定性路由 | `:665` |
| `writer-boundary-bypass` | control_flow + lane_ownership | 提交绕过唯一 writer；或 worker 与 writer 共用一条含该文件 write rule 的 Lane | `:677`、`:685` |
| `state-routing-divergence` | control_flow | writer 原样落盘 `$output`，却声称字段已被 Transition updates 确定性覆盖，导致磁盘状态与路由分叉 | `:679` |
| `missing-precondition` | runtime_preconditions | 首个 Activation 依赖但项目中缺失、且不在 preconditions 清单中的文件 / 外部 CLI / 凭据；被默认代答却未列为 decision 的决策；凭空发明的目录名 | `:667` |

> `missing-source-bound` 就是本次 F1 run 里 C18 的归属：
> 「最多执行 20 个有效候选轮次」（`f1_loop.md:152`）在图中只有
> `maxTotalActivations=120`，二者无确定性换算关系。

---

## 5. 表 C — advisory 白名单（9 条）

写进 artifact、喂给下一轮 compiler 作为参考，但**不阻断** Distill。

| ruleClass | 层 | 判据 | 来源条目 |
|---|---|---|---|
| `topology-granularity` | lane_ownership | Agent 拆分 / 合并粒度偏好 | `:685` |
| `session-continuity` | lane_ownership | 强相关生命周期是否应保持连续会话 | `:664` |
| `budget-shape` | control_flow | turns / usd / lifetimeBudget 数值是否与任务规模匹配（下限由 lint 兜底） | `:687` 残余 |
| `semantic-classification` | control_flow | 三态枚举被压成布尔；「变差」被压成「未改善」 | `:681` |
| `threshold-truth-table` | control_flow | stale 四分区等具体阈值真值表的推导是否精确 | `:681` |
| `branch-priority` | control_flow | 高优先级分支遮蔽完成条件；每轮计数未在所有提交分支更新 | `:681` |
| `commit-ordering` | control_flow | 评估前就写入最终 append-only 文件 | `:681` |
| `workspace-mode-mismatch` | workspace_contract | append/replace 语义不一致、deny 粒度 | `:663` |
| `overreach-obligation` | intent_constraints | 从 rationale / taskSpec / 惯例反推出来源没有的义务 | `:683` |

---

## 6. 待拍板的取舍

`semantic-classification`、`threshold-truth-table`、`branch-priority` 三条被放进 advisory，
但它们确实属于「逻辑问题」。

- **放 advisory 的理由**：它们是**领域逻辑**而非**控制流安全性**——图能跑，只是可能算错。
  而且这三类要求 reviewer 从自然语言推真值表，是假阳性最集中的地方。
  Loop 跑起来之后这些是可观测、可修的；卡在 Distill 出不来则什么都得不到。
- **放 blocking 的理由**：算错 stale 会让整个 loop 的 pivot / attention 决策失真，
  而这正是 loop 存在的意义。

建议先按 advisory 跑几轮，观察实际产出的图在这三类上错得有多离谱，再决定是否上提。

---

## 7. Schema 变更

```ts
export type SemanticRuleClass =
  // blocking
  | 'unimplemented-hard-constraint' | 'constraint-weakened'
  | 'dangling-traceability' | 'fabricated-capability' | 'annotation-only-satisfaction'
  | 'unbounded-or-unreachable-control' | 'missing-source-bound'
  | 'writer-boundary-bypass' | 'state-routing-divergence'
  | 'missing-precondition'
  // advisory
  | 'topology-granularity' | 'session-continuity' | 'budget-shape'
  | 'semantic-classification' | 'threshold-truth-table' | 'branch-priority'
  | 'commit-ordering' | 'workspace-mode-mismatch' | 'overreach-obligation'

export const BLOCKING_RULE_CLASSES: ReadonlySet<SemanticRuleClass> = new Set([
  'unimplemented-hard-constraint', 'constraint-weakened',
  'dangling-traceability', 'fabricated-capability', 'annotation-only-satisfaction',
  'unbounded-or-unreachable-control', 'missing-source-bound',
  'writer-boundary-bypass', 'state-routing-divergence',
  'missing-precondition',
])

export interface SemanticFinding {
  ruleClass: SemanticRuleClass
  statement: string
  sourceRefs: string[]
  designRefs: string[]
  graphRefs: string[]
}

export interface LayeredSemanticReview {
  schemaVersion: typeof SEMANTIC_REVIEW_SCHEMA
  /** 宿主计算，模型输出的同名字段一律忽略。 */
  accepted: boolean
  layers: Record<SemanticReviewLayer, {
    status: 'pass' | 'fail' | 'not_applicable'
    evidence: Array<{ sourceRefs: string[]; designRefs: string[]; graphRefs: string[]; statement: string }>
    findings: SemanticFinding[]
  }>
}
```

宿主侧判定：

```ts
const findings = SEMANTIC_REVIEW_LAYERS.flatMap(l => review.layers[l].findings)
const blocking = findings.filter(f => BLOCKING_RULE_CLASSES.has(f.ruleClass))
const accepted = blocking.length === 0
```

变更要点：

1. **删掉 `warnings` 字段**和 `parseLayeredSemanticReview:1046` 的 `if (warnings.length) continue`。
   advisory findings 取代了原来的 warnings，但它们有 ruleClass、被持久化、且会喂回 compiler。
2. **`issues: string[]` → `findings: SemanticFinding[]`**，每条带 ruleClass 和引用。
3. **模型不再决定 `accepted`。** 解析时忽略模型填的值，由 `BLOCKING_RULE_CLASSES` 算出来。
4. `:1026`（pass 层不许带 issue）改为：pass 层不许带 **blocking** finding，可带 advisory finding。

## 8. 残余风险

模型仍可能把本该是 `unimplemented-hard-constraint` 的问题误报成 `topology-granularity`
来放行。这个风险无法从机制上完全消除，但相比现状有两点改善：

- ruleClass 是**固定枚举**而非自由文本，误分类在 artifact 里可见、可审计、可回归测试；
- 配合方案 1（全阶段留痕），每轮 findings 都落盘，误分类模式能被统计出来。

## 8.5 执行落点（enforcement locus）

分级解决了「小问题当大问题」，但没有解决**另一类根本不可修的 finding**。

三份提示词是互斥的：Architect 被要求「稀疏控制骨架 + 厚 Agent 节点」却「不得因拓扑合并丢失约束」
（于是一份祈使语气的操作手册被逐句抽成 hard constraint），Compiler 被要求把紧耦合语义
**留在 Agent 内**，Reviewer 却被要求每条 hard constraint 都在 Graph 里有可执行落点。

机械校验拦不住这个矛盾：`validateGraphTraceability` 原本只检查 JSON pointer **存在**，
所以 Compiler 指向 `/nodes/work` 就能过；Reviewer 再语义地判定「这个指针没有真的实现它」。
像「根据历史发现选择最值得验证的假设」这种约束，Compiler 只有两条路而两条都被堵死——
伪造 Function（提示词明令禁止）或指向厚 Agent（被判 annotation-only）。**这类 finding 改不好，
而它的数量随来源文档长度增长。**

落点把这个隐含维度显式化，且**由宿主从 `kind` 机械推导，模型不参与**：

| kind | locus | 含义 |
|---|---|---|
| deterministic_rule / workspace_protocol / ownership / terminal_obligation / failure_boundary / recovery / budget / timer / event / other | **graph** | 必须落在 Transition、Lane.workspace、State 更新、limits 或终态上 |
| goal / success_criteria | **agent** | Graph 中没有对应元素就是正确设计；只核验责任 Agent 被交底 |
| capability | **human** | 进 preconditions，由人确认 |

`other` 保守归 graph：分类不清时保持严格读法，让错标响亮地失败而不是悄悄逃逸。

配套改动：

- `validateGraphTraceability` 分档——graph 落点不接受只指向 `/nodes/*/prompt`、
  `systemInstructions`、`description`；agent 落点接受。annotations 对任何落点都不接受。
- 新增阻断类 `unbriefed-agent-constraint`：把约束交给 Agent 判断是合法的，交给**没有人**不是。
- Reviewer 提示新增【执行落点】节，明确 agent 落点「Graph 中没有对应元素**不得据此提出任何 finding**」。
- Architect 提示说明 `kind` 不再是自由标签，它决定执行落点。

为什么模型无法利用这条逃逸：`kind` 是受限枚举，由 Architect 对着来源原文标注，
且在任何 Graph 存在**之前**——没有「为了让候选通过而降级」的动机路径。

## 9. 实施记录

| 步骤 | 状态 | 落点 |
|---|---|---|
| 方案 1 全阶段留痕 | 已实施 | 新增 `DistillTrace.ts`；`GraphDistiller` 在每个 attempt 的 accepted/unparseable/invalid/frozen/rejected 分支落盘；`loop/cli.ts` 接线；fatal 追加 trace 目录 |
| 表 A 移交 lint | 已实施 | 新增 `lane-write-overlap`(error)、`redundant-mkdir`(warning)；reviewer 提示新增「已由确定性 Lint 拥有，不要复查」段并删除对应旧条目 |
| 表 B/C 分级 | 已实施 | `SEMANTIC_RULE_CLASSES` / `BLOCKING_SEMANTIC_RULE_CLASSES`；`issues`→`findings`；删除 `warnings`，新增 `advisories`；`accepted` 由宿主计算 |
| 执行落点 §8.5 | 已实施 | `deriveEnforcementLocus` / `enforcementLocusIndex` / `formatEnforcementLoci`；traceability 分档；新增 `unbriefed-agent-constraint`；三份提示词同步 |
| 提示词梳理 | 已实施 | Compiler 清除领域模板（`stale_count`/`no_progress`/`attention`/`pivot>=2` 等一组特定 loop 的词汇与字面阈值）；合并 4 条 writer 规则为 2 条；补 hard-park 与时间约束的因果；删除 `parseGraphDistillOutput`、`buildLayeredGraphDistillerSystem` 死代码 |
| `dead-state-field` lint | 已实施 | error 级；3 张真实图 0 误报（含一张已被 reviewer 接受的） |
| metadata 回收夹缝 | 已修复 | `graph` 被写成 `null`/占位串/`{}` 时不再丢弃已冻结图 |
| 方案 2c 固定清单 | 未做 | 待 trace 积累更多真实 verdict 后再定 |

产物布局（`.loop/distill/run-<ISO>/`）：

```
timeline.jsonl                      每个阶段结果一行
architect.r0.a1.output.txt          解析失败时的原始输出
architect.r0.a1.accepted.json       通过的 {constraints, design}
compiler.r0.a3.output.txt           解析失败时的原始输出
compiler.r0.a3.frozen-graph.json    解析失败但 graph_validate 已冻结的图
compiler.r0.a3.graph.json           冻结通过的图（即使随后被语义拒绝）
compiler.r0.a3.rejected.json        { errors, graph, traceability }
review.r0.c3.json / .md             完整分层裁决 + 渲染版
```

`r<N>` 是 `semanticRevision`，因此 intent_constraints 触发的 Architect 重跑（递归调用）
不会与外层的 attempt 编号相撞，两轮都留在同一个 run 目录里。

### 9.1 留痕带来的读回风险及其封堵

留痕落在 `<projectDir>/.loop/distill/` 内，而 Architect 与 Reviewer 都持有覆盖整个
workspace 的 read_file / grep / glob。`tools/fs/glob/index.ts:38` 的 `SKIP_DIRS` 只排除
`node_modules`、`.git`、`dist`、`.next`、`coverage`、`__pycache__` —— **不含 `.loop`**。
也就是说 `glob('**/*.json')` 会把本轮自己的 `review.r0.c3.json`、
`compiler.r0.a3.rejected.json` 一并列出来，read_file 也没有任何限制。

这会带来两个真实危害，而不只是"不纯粹"：

1. Reviewer 可能读到上一轮自己的裁决并据此锚定，把刻意设计的无状态复核变成
   **偶发且不可复现**的有状态——比两个极端都糟。
2. Reviewer 可能把 `compiler.*.rejected.json` 里的图误当成当前候选来审。

封堵方式是 `src/cli/distillTraceGuard.ts` + `foregroundDistillConfig` 的
`beforeToolCall(toolName, input)`（该回调本来就能看到入参）：递归扫描所有字符串入参，
命中 `.loop/distill` 即 deny。不改全局 glob 行为，`.loop/instances/` 保持可读——
运行时状态在核验 runtime_preconditions 时是正当证据。

注：`architect.checkpoint.json` 在本次留痕改动之前就已经落在同一目录，因此这个读回
面并非新引入，只是留痕让它变得富含内容、值得封堵。

验证：`tsc --noEmit` 通过；`vitest run` 全量 166 文件 / 1290 用例通过，其中新增
lint 规则 3 例、trace 4 例、分级判定 3 例。
