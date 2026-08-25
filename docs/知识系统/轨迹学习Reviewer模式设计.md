# 轨迹学习 Reviewer 模式设计

> 状态：TaskCase + Kernel ReviewerSession + TaskReview 核心闭环已实现（跨任务聚类与矛盾分析待实现）
>
> 日期：2026-08-23
>
> 依赖：canonical trajectory 及其 ordinal、轨迹身份和证据引用能力
>
> 相关文档：[`meta-agent-自进化方案.md`](../reviews/meta-agent-自进化方案.md)、[`meta-agent-迭代计划-2026H2.md`](../reviews/meta-agent-迭代计划-2026H2.md)、[知识系统 v1](./知识系统v1-经验与锚点.md)

## 0. 执行摘要

`reviewer` 是一个由人手动启动的一等分析模式。它以独立 `ReviewerSession` 复用 KernelLoop 的多轮模型—工具循环，但不继承 Auto/Agentic 的任务执行和 workspace 修改语义。它先把 root trajectory、child/subagent trajectory 和多次 run 组成一个 `TaskCase`，生成完整的过程审计 `TaskReview`；只有其中高价值、可迁移的方法论 Finding 才能形成 `LearningProposal`。人明确审核通过后，系统才物化 `ExperienceCandidate`。

这一阶段的目标不是让 meta-agent 自动修改自己，而是先建立一个可靠的“从实践中学习”抽象层。

Reviewer 的第一核心产物不是经验列表，而是回答：

> Agent 实际走了什么解决路径，路径选择是否合理或接近最优，成功指标是否合适，完成声明是否诚实，以及长周期中是否发生信息遗漏、遗忘、噪声累积或目标偏移。

任务内发现的具体 bug、参数、文件、命令和领域结论只作为上述判断的证据。Reviewer 不是知识库摘录器，也不把每个真实缺陷都晋升为经验。

经验提炼是任务复盘的最后一步：

> 下一次遇到什么情境或信号时，Agent 应该改变哪个判断或动作，为什么，以及如何验证这条经验仍然成立。

一期约束：

- 逻辑上可盘点全部有资格的 trajectory，物理上按 TaskCase 聚合，并由 Reviewer 工具按 ordinal 搜索、分段读取，不将全部原文塞入初始上下文。
- trigger window 只作为调查线索，不直接决定经验价值。
- Reviewer 默认只有 TaskCase 内的只读证据工具，不获得任意 workspace 写能力。
- Reviewer 自己记录 `mode=reviewer` 的分析轨迹，但默认排除于后续被审输入，避免递归自审。
- 只有对解决方法、判断策略、验证策略或信息控制具有任务族级/跨任务价值的 Finding 才能产生经验候选。
- 大多数 TaskCase 可以合法地产出没有 LearningProposal 的 TaskReview，不追求候选数量。
- 每个结论必须引用 trajectory ordinal 或 graph journal sequence；没有证据的泛化不得写入候选。
- AI 分析结果只能写成 `pending` 的 `LearningProposal`，不得直接创建 `ExperienceCandidate`。
- 只有人工 `approve` 可以创建 `ExperienceCandidate`；拒绝和跳过都不会产生 Candidate。
- Reviewer 只写独立的 reviewer artifacts，不写正式 ExperienceStore 或其 pending 队列，不修改 Prompt、Graph、Skill 或正在运行的 Agent。
- 第一版聚焦“可靠、稳定、能干事”三个目标，不引入自动注入、自动晋升或自动进化闭环。

## 1. 定位与边界

### 1.1 与任务 Reviewer 区分

meta-agent 中已经存在面向当前任务结果的 Reviewer。为避免语义混淆，本文内部使用两个名称：

| 角色 | 审查对象 | 问题 | 产物 |
| --- | --- | --- | --- |
| Completion Reviewer | 当前 Worker 的任务结果与证据 | 这次任务是否真的完成 | pass / reject / critique |
| Learning Reviewer | 一个 root + child 构成的完整 TaskCase | 解决路径是否正确、指标和完成声明是否可信、长周期信息是否受控 | TaskReview + pending LearningProposal |
| Human Reviewer | LearningProposal 及其 EvidenceRef | 证据、机制和适用边界是否可信 | approve → ExperienceCandidate / reject |

Completion Reviewer 的驳回是 Learning Reviewer 的一种证据来源，但前者不直接生成经验。

### 1.2 学习不等于重复

实践只在出现有信息量的反馈时才可能导致学习。没有清晰反馈的重复可能只会固化原有行为，甚至把错误练熟。

Reviewer 重点关注以下时刻：

- 结果与预期明显不一致；
- 同一问题或错误签名重复出现；
- Completion Reviewer 指出了 Worker 未意识到的缺口；
- 人类纠正了 Agent 的事实、判断、完成声明或行动；
- 策略改变后，成功率、验证强度、成本或步骤数出现明显改善；
- 原有经验在新证据下被限制或证伪；
- 不同任务表面不同，但出现相同的触发信号、失败机制和有效策略变化。

### 1.3 四个复盘维度

Reviewer 不使用单一总分表示任务质量，而是分别记录四个维度；前三个对应“可靠、稳定、能干事”，效率用于回答“怎样更快”。

| 维度 | 定义 | 典型改善 |
| --- | --- | --- |
| 可靠 Reliability | 结论和完成声明是否有充分、独立、可对账的证据支持 | 更好的验收、更少 false success、更准确的错误归因、更安全的操作 |
| 稳定 Stability | 多次运行是否表现一致，是否减少振荡、原样重试和偶然上下文依赖 | 更少重复失败、更明确的恢复条件、更低方差、更可预期的资源消耗 |
| 能干事 Effectiveness | 是否真正完成用户目标并交付可用结果 | 更好的工具选择、更有效的问题分解、新的可行策略、真实可用的产物 |
| 效率 Efficiency | 时间、turn、工具、重试和模型成本是否主要用于获得新信息或完成目标 | 更少无信息调用、更短关键路径、更好的并行与按需读取 |

## 2. 总体模型

Reviewer 使用五个核心抽象和一个硬性人工闸门：

```text
root + child trajectory / graph journal
                │
                ▼
            TaskCase
     一个任务的完整证据边界
                │
                ▼
      Kernel ReviewerSession
  多轮只读搜索、读取与证据调查
                │
                ▼
           TaskReview 2.0
 路径、指标、完成诚信、信息与长周期审计
                │
                ▼ high-value gate
       LearningProposal (pending)
                │
                ▼
        Human review gate
          approve / reject
                │ approve only
                ▼
       ExperienceCandidate
      经人确认的策略差分候选
                │
                ▼
  cluster / contradiction / revision
                │
                ▼
          ReviewReport
```

`TaskCase` 是任务证据边界：同一个 root 下的子 Agent 是协作视图，不是独立复现。

`TaskReview` 是解决过程审计层：在目标、关键决策和结果证据之上，强制重建分阶段解决路径，并分别审计路径质量、成功指标质量、完成声明诚信、决策信息充分性和长周期信息控制。effectiveness、reliability、stability、efficiency 保留为整体结果维度。

`LearningMoment` 是 TaskReview 内高价值 Finding 的事件层证据：尽可能忠实地重建发生了什么。

`LearningProposal` 是 AI 建议层：明确说出未来哪个行为应该发生改变，但尚不具有 Candidate 身份。

`ExperienceCandidate` 是人工认可层：内容来自已审核 Proposal，并保留 Proposal、Moment 和原始轨迹的证据链。这里的 Candidate 仍不是正式经验，也不会被现有 Agent 召回。

两者不得合并成一步。如果直接要求模型“从轨迹总结经验”，模型容易将事后解释、常识和泛化建议写成伪经验。

## 3. 证据与基础记录

### 3.1 EvidenceRef

所有轨迹学习产物都使用精确引用，不复制一份无法对账的轨迹摘要。

```ts
interface EvidenceRef {
  trajectoryId: string
  ordinal: number
  itemType: string
  journalSequence?: number
  artifactHash?: string
  role:
    | 'context'
    | 'expectation'
    | 'action'
    | 'outcome'
    | 'feedback'
    | 'correction'
    | 'verification'
    | 'contradiction'
}
```

同一证据可被多个 Moment 引用；Review artifacts 不是 trajectory 的真相源，丢失后应可由 trajectory 重建。

### 3.2 ReviewerRunManifest（legacy window runner）

旧的窗口级 API 仍保留兼容，每次执行产生 `trajectory-review-run-1.0`：

```ts
interface ReviewerRunManifest {
  schemaVersion: 'trajectory-review-run-1.0'
  runId: string
  createdAt: number
  completedAt: number
  analyzerId: string
  scope: {
    all: boolean
    limit?: number
    trajectoryId?: string
    workspace?: string
    since?: number
    maxWindows: number
    force: boolean
  }
  inputHashes: Record<string, string>
  completedTrajectoryIds: string[]
  completedWindowKeys: string[]
  stats: {
    trajectoriesSelected: number
    trajectoriesScanned: number
    trajectoriesSkipped: number
    trajectoriesUnchanged: number
    candidateWindows: number
    modelCalls: number
    windowsSkippedBudget: number
    windowsPreviouslyReviewed: number
    proposalsGenerated: number
    proposalsDeduplicated: number
    noLearningWindows: number
    qualityRejections: number
    analysisErrors: number
    unknownVerdicts: number
  }
  proposalIds: string[]
  skipped: Array<{ trajectoryId: string; reason: string }>
  noLearning: Array<{ windowId: string; reason: string }>
  qualityRejections: Array<{ windowId: string; proposalIndex: number; reason: string }>
  analysisErrors: Array<{ windowId: string; error: string }>
  unknownVerdicts: Array<{
    trajectoryId: string
    ordinal: number
    evaluator: string
    verdict: string
  }>
}
```

该 manifest 只服务仍显式调用 `runTrajectoryReview` 的兼容调用方；CLI 默认已切换到下述任务级 manifest。该 API 已标记 `@deprecated`，计划在 v1.0.0 删除。

### 3.3 TaskReview 与任务级 Run Manifest

当前 CLI 每个完整 TaskCase 生成一份 `TaskReview`，包含：

- 重建后的任务目标、约束和逐条成功标准；
- `observed / inferred / unknown` 三类观察；
- 关键决策、理由、备选路径和结果；
- `solved / partial / failed / unknown` 结果判定；
- effectiveness、reliability、stability、efficiency 四维证据化评估；
- 分阶段实际解决路径，以及相对当时可知信息的路径质量与更优反事实路径；
- 成功指标是否充分、是否存在缺失或误导性指标；
- 完成声明是否证据充分，是否 overclaim、隐藏未解决事项或以 proxy 冒充结果；
- Agent 决策时的信息缺口与 Reviewer 当前的轨迹可见性缺口（两者不得混淆）；
- 长周期中的 information omission、memory loss、noise accumulation、goal drift 及连续性机制；
- solution strategy、path selection、success criteria、completion integrity、information management、long-horizon control、verification strategy、efficiency strategy 八类方法论 Finding；
- 关联的高价值 `LearningProposal` ID。

`task-review-1.0` 的旧领域 Finding 报告继续可读；所有新运行生成 `task-review-2.0`。

任务级运行使用 `task-review-run-2.0`，预算字段为 `maxCases`、`maxTurnsPerCase`、`maxBudgetUsd`，统计 Kernel session、turn、证据工具调用和实际成本。复盘增量身份为 `caseId + inputHash + analyzerId`；Proposal 身份则独立使用 `analyzerId + caseId + findingId`。因此新活动会触发重新复盘，但不会让已经拒绝的同一 Finding 复活。已经存在 Proposal 的 TaskCase 即使 `--force` 也不会重分配不可变提案身份。

## 4. LearningMoment 建模

### 4.1 Schema

```ts
type LearningMomentKind =
  | 'expectation_mismatch'
  | 'repeated_failure'
  | 'reviewer_correction'
  | 'human_correction'
  | 'breakthrough'
  | 'contradiction'
  | 'transferable_pattern'

interface LearningMoment {
  schemaVersion: 'learning-moment-1.0'
  id: string
  kind: LearningMomentKind

  context: {
    taskSummary: string
    taskFamily?: string
    workspaceId?: string
    graphHash?: string
    nodeId?: string
    relevantState: string[]
  }

  expectation?: {
    statement: string
    source:
      | 'agent_explicit'
      | 'task_contract'
      | 'action_implied'
      | 'reviewer_inferred'
    confidence: 'high' | 'medium' | 'low'
  }

  action: string
  observedOutcome: string
  feedback?: string
  correction?: string
  correctedOutcome?: string

  transferableHint?: string
  evidence: EvidenceRef[]
}
```

### 4.2 预期的证据等级

“预期与结果的差异”是学习的重要信号，但 Agent 往往没有显式写出预期。Reviewer 必须保留预期的来源：

| 来源 | 含义 | 默认置信 |
| --- | --- | --- |
| `agent_explicit` | Agent 在行动前明确声明预期 | 高 |
| `task_contract` | 预期由任务验收、output contract 或固定规则给出 | 高 |
| `action_implied` | 从 Agent 选择的行动反推其预期 | 中或低 |
| `reviewer_inferred` | Learning Reviewer 根据上下文重建 | 低 |

推断可以用于发现候选，但不得伪装成 Agent 当时显式持有的信念。

### 4.3 当前高信号入口

当前确定性扫描器先为三类高信号建立有界窗口，再由 Learning Reviewer 判断它们是否真的构成 Moment：

1. **Reviewer correction 入口**：Auto Verify 会把真实 verdict 写成 `evaluation`，扫描器只接受明确的负向 verdict；同时兼容旧轨迹中的 `[系统·完成度审核 第 N 轮]` meta message。同一 run 已有结构化 `auto_verify` evaluation 时不再为 legacy message 建第二个窗口。`pass_with_notes`、`satisfied`、中文“通过”等明确正向值不会误触发；无法识别的新 verdict 进入运行报告，不静默猜测成败。
2. **Repeated failure 入口**：同一归一化工具错误签名至少出现两次；重复本身只触发分析，不保证生成 Proposal。相邻 pair 的上下文重叠达到 80% 时合并窗口并保留全部触发 ordinal，避免密集失败按 pair 放大模型调用；跨度较大的复现仍保留晚期局部上下文。
3. **Human correction 入口**：存在 `decidedBy: 'human'` 的 `deny`/`redirect` approval，或带 `isSteering: true` 的用户纠偏消息。Kernel 权限决策会保留 `human`、`policy`、`hook` 等来源，避免把策略拒绝误认成人工反馈。

`expectation_mismatch`、`breakthrough`、`contradiction` 和 `transferable_pattern` 先保留在 schema 中，等一期证据链跑通后再开放自动发现。

## 5. LearningProposal 与 ExperienceCandidate 建模

### 5.1 核心定义

经验草案不是一段“知识文本”，而是一条条件化的策略差分：

```text
适用情境 Context
+ 触发信号 Cue
+ 策略差分 Policy Delta
+ 原因机制 Mechanism
+ 验证方法 Verification
+ 适用边界 Boundary
+ 证据 Evidence
```

一条经验草案的最小价值是：它能让未来 Agent 在行动之前识别适用情境，并改变一个具体判断或动作。AI 生成这个草案时，它只是 Proposal 的一部分。

### 5.2 Schema

```ts
type ExperienceCategory =
  | 'diagnosis'
  | 'strategy_selection'
  | 'procedure'
  | 'verification'
  | 'recovery'
  | 'tool_usage'
  | 'calibration'

type ImpactLevel = 'none' | 'low' | 'medium' | 'high'

interface LearningProposal {
  schemaVersion: 'learning-proposal-1.0'
  id: string
  fingerprint: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: number
  source: {
    reviewerRunId: string
    windowId: string
    windowHash: string
    proposalIndex: number
    trigger: string
    trajectoryIds: string[]
    analyzerId: string
  }
  moment: LearningMoment
  experienceDraft: ExperienceDraft
  review?: {
    decision: 'approved' | 'rejected'
    reviewedAt: number
    reviewedBy: 'human'
    note?: string
  }
}

interface ExperienceCandidate {
  schemaVersion: 'experience-candidate-1.0'
  id: string
  proposalId: string
  revision: number
  status: 'approved'
  approvedAt: number
  approvedBy: 'human'
  reviewNote?: string

  title: string
  category: ExperienceCategory

  applicability: {
    context: string
    cues: string[]
    prerequisites: string[]
    excludes: string[]
  }

  policyDelta: {
    previousApproach?: string
    recommendedAction: string
    avoidAction?: string
    expectedEffect: string
  }

  mechanism: string

  verification: {
    checks: string[]
    successSignals: string[]
    failureSignals: string[]
  }

  impact: {
    reliability: ImpactLevel
    stability: ImpactLevel
    effectiveness: ImpactLevel
    rationale: string[]
    observedMetrics?: Record<string, number>
  }

  evidence: {
    supportingMomentIds: string[]
    contradictingMomentIds: string[]
    independentTrajectories: number
    independentWorkspaces: number
  }

  confidence: 'hypothesis' | 'observed' | 'reproduced'
}
```

`ExperienceDraft` 即 Candidate 中从 `title` 到 `impact` 的策略内容。`LearningProposal.status` 记录审核历史；`ExperienceCandidate` 只存在于批准分支，所以没有 `pending` 或 `rejected` 状态。这样可以从数据类型上阻止“AI 输出即 Candidate”。当前版本不允许在批准时由模型静默改写草案；人要么批准当前内容，要么拒绝后重新生成或在后续版本引入显式修订。

### 5.3 类别的语义

| 类别 | 回答的问题 | 例子 |
| --- | --- | --- |
| `diagnosis` | 看到这个信号时，应优先怀疑什么 | 局部测试通过但完整构建失败时，先检查生成产物一致性 |
| `strategy_selection` | 在什么条件下选哪种解题路径 | 错误跨越模块边界时，从最终验证错误反向定位边界 |
| `procedure` | 哪组步骤顺序值得固定下来 | 先建立最小复现，再修复，最后运行全量验证 |
| `verification` | 什么证据才足以声明完成 | 最后相关 diff 后必须重新运行验收命令 |
| `recovery` | 失败后怎样恢复而不是原样重试 | 错误签名重复且无新 diff 时，先更换假设或补充证据 |
| `tool_usage` | 某类工具何时、如何使用更有效 | 优先使用结构化搜索缩小范围，再读取完整文件 |
| `calibration` | 什么情况下应降低置信、补证或求助 | 只有 LLM 对代码的语义判断而无执行证据时，不得高置信签发完成 |

### 5.4 三维影响不是 LLM 自由打分

`impact` 不应只由 Reviewer 输出三个印象分数。一期允许 Reviewer 给出等级和理由，但必须同时保留可对账的观测指标；后续由宿主根据证据计算或修正等级。

可用的宿主事实包括：

- 是否从 false success 转为有确定性证据的完成；
- 相同错误签名是否停止重复；
- 策略切换前后的 turns、duration、cost 和 tool failure 数量；
- 最后相关 diff 之后是否有新验收证据；
- 是否从 paused / blocked 恢复到经验证的 terminal result；
- 经验在后续独立轨迹中被支持或反驳的次数。

## 6. 经验质量门槛

### 6.1 六个必须回答的问题

每条 LearningProposal 必须先通过宿主质量门槛，再由人审核；批准后才成为 ExperienceCandidate：

1. Agent 能否在行动前识别它的适用情境或触发信号？
2. 它是否会改变一个具体判断或动作？
3. 它是否说明了为什么，而不是只给命令？
4. 它是否给出了可执行的验证方法？
5. 它是否声明了适用边界，并允许被未来证据推翻？
6. 关键事实、反馈、修正和结果是否都有精确 EvidenceRef？

一个简单的二次判断是：

> 删除这条经验后，未来 Agent 的某个具体决策会不会发生变化？

如果不会，它就是摘要、感想或一般性建议，不是经验。

### 6.2 必须拒绝的产物

- “以后要更仔细”、“应该多测试”、“遇到错误要认真分析”等无法执行的口号；
- 对一次成功的事后合理化；
- 只有任务特定细节，没有可识别的未来适用条件；
- 没有真实结果支持的“最佳实践”；
- 将同时发生当作因果机制；
- 把项目事实、用户偏好或硬件常量强行塞进经验；
- 转抄原始轨迹或长篇工具输出；
- 将 Reviewer 推断的预期写成 Agent 当时的显式信念。

### 6.3 输出路由

轨迹中的有价值信息不一定是 Experience。Reviewer 允许将候选路由为：

| 路由 | 适用对象 |
| --- | --- |
| `experience_candidate` | 有适用情境和策略差分的可复用实践经验 |
| `workspace_fact` | 只对当前项目或 workspace 成立的事实 |
| `anchor_candidate` | 有观测证据的稳定物理、设备或环境事实 |
| `skill_candidate` | 已经形成稳定、可重复的多步程序 |
| `system_issue` | 反复失败指向工具、Prompt、Reviewer、Runtime 或 Graph 机制问题 |
| `no_learning` | 没有足够证据，或无法改变未来具体决策 |

当前实现始终生成 TaskReview；只有 `experience_candidate` 方向且通过高价值门的 Finding 才生成 pending Proposal。其他 Finding 保留在 TaskReview，尚不写入任何下游系统。

## 7. Reviewer 执行流程

### 7.1 阶段 A：TaskCase 聚合

根据手动范围列出 trajectory，使用 `rootTrajectoryId / parentTrajectoryId` 将 root、child/subagent、多次 run 聚合成 TaskCase。指定任一 child trajectory 时，审查的仍是整个 root TaskCase。`mode=reviewer` 的分析轨迹默认排除。

“扫描全部”的含义是所有符合资格的 TaskCase 都进入盘点，不是将全部消息和工具输出一次性读入模型上下文。TaskCase 任一成员存在活跃 writer lease 时，整个 case 跳过，避免在变化中的证据上形成完成判断。

### 7.2 阶段 B：确定性索引与导航信号

宿主先提取任务拓扑、聚合指标、run result 和 trigger hints：

- run 开始、结束和 terminal outcome；
- tool command、cwd、exit code、duration 和结构化错误；
- turn diff 及发生时间；
- evaluation / Reviewer verdict；
- human approval、拒绝、修正和后续结果；
- retry、replay、paused、blocked、exhausted；
- 重复工具调用和重复错误签名；
- knowledge recall 及其后续支持或矛盾信号；
- turns、cost、duration 和并发情况；
- 最后相关 diff 与验收证据的先后关系。

预扫描不做任务结论，只产生可重建事实和调查入口。以下旧窗口规则继续作为 trigger hints：

- Completion Reviewer reject 前后的 ordinal 窗口；
- 同一错误签名每一对相邻复现的窗口；
- human steering、人工 deny/redirect approval 与之后验证的窗口。

窗口只用于快速跳转；Reviewer 可以越过窗口，通过工具查看 TaskCase 内其他必要证据。

### 7.3 阶段 C：Kernel ReviewerSession 调查

每个 TaskCase 启动一个独立 KernelLoop 会话。会话的 cwd 与 permission workspaceRoot 指向一次性、只读的空目录，而不是被审工作区；当前只注册四个 case-confined、只读工具：

- `review_case_overview`：任务拓扑、聚合指标、run results 和 trigger hints；
- `review_trajectory_read`：按 trajectory + ordinal 有界读取；
- `review_trajectory_search`：在宿主脱敏后的证据中做字面搜索；
- `review_trigger_context`：展开一个 trigger hint 的局部上下文。

Reviewer 必须至少调用一次证据工具；不允许只根据初始摘要直接输出结论。ReviewerSession 有自己的 `mode=reviewer` canonical trajectory，记录模型、工具与最终分析过程，便于审计，但不会被默认再次审查。结构化输出上限为 32k token；如果工具调查门槛或 JSON 解析失败，宿主会将二次脱敏后的原始响应保存在对应 run 的 `analysis/` 目录，并由 manifest 的 `rawResponseArtifact` 指回，供人工挽救。

### 7.4 阶段 D：TaskReview 重建

Reviewer 先回答：Agent 看到了什么、推断了什么、遗漏了什么；采取了哪些关键决策；成功标准逐条是否满足；实际结果是 solved、partial、failed 还是 unknown。随后必须重建实际解决路径，并完成五项独立审计：路径质量、指标质量、完成诚信、信息充分性、长周期信息控制。最后才允许提出方法论 Finding。

路径评价遵守“当时可知信息”原则，不能使用后来才获得的信息反向苛责早期决策。信息不足必须拆成三类：环境没有提供、Agent 没有主动获取、Reviewer 因轨迹记录不足无法判断。长周期审计则显式检查跨 retry、compaction、child agent、park/resume 和多次 run 的信息遗漏、遗忘、噪声与目标偏移。

模型给出的所有 `trajectoryId + ordinal` 由宿主在完整 TaskCase 边界内校验并补充 `itemType`。悬空证据、把无证据推断标成 observed、未知结果下声称成功策略等都会被拒绝。

结构化输出采用两阶段解析：任务目标、观察、决策、结果、四维评估、五项过程审计和方法论 Findings 作为严格 TaskReview 主体解析；`proposalCandidates` 再逐条独立规范化与校验。`failure`、`failed`、`error`、`result`、`success` 等结果角色别名统一映射为 `outcome`。无法安全修复的单条候选进入 `qualityRejections`，但不得让完整 TaskReview 退化为 analysis error。

Finding 类别保持八类方法论闭集；若模型误用相邻 ExperienceDraft 或 v1 分类，宿主只做含义确定的过程级映射。对相同 `caseId + inputHash + analyzerId` 的失败 run，后续运行会先尝试重新解析已脱敏的 raw-response artifact；恢复成功则直接物化 TaskReview，不重复调用模型，恢复失败才启动新的 Kernel ReviewerSession。Reviewer analyzer 版本升级到 v2，因此旧格式 raw response 不会被误恢复成新报告。

### 7.5 阶段 E：高价值门与 LearningProposal

Finding 只有同时满足以下条件才允许转成 Proposal：

- `significance` 为 `critical` 或 `major`；
- `candidateEligible=true`；
- `abstractionLevel` 为 `task_family` 或 `cross_task`，不得为 `task_specific`；
- reliability、stability、effectiveness 至少一个影响为 `high`；
- Proposal 与 Finding 共享真实证据；
- LearningMoment 至少引用两个不同证据位置，并包含 outcome、feedback、correction、verification 或 contradiction 之一。

未通过的提案进入 `qualityRejections`；ReviewerSession/结构化输出故障进入 `analysisErrors`，两者不混用。TaskReview 即使没有 Proposal 仍是合法且重要的产物。

### 7.6 阶段 F：人工审核与 Candidate 物化

人工审核有三个结果：

- `approve`：写入 Proposal 的人工决定，并从其草案物化唯一、幂等的 `ExperienceCandidate`；
- `reject`：保留 Proposal 与拒绝理由供审计，不创建 Candidate；
- `skip`：保持 `pending`，以后再审。

交互式审核不接受 `--yes` 自动批准。显式 `reviewer approve <id>` 被视为操作者针对该 ID 作出的人工决定。批准操作可幂等重试，进程若在 Candidate 与 Proposal 两次原子写之间中断，下次批准会修复状态。

### 7.7 阶段 G：跨轨迹聚类与矛盾分析（后续）

聚类优先使用三个语义要素，不只使用表面关键词：

```text
相似的 Cue
+ 相似的失败或成功机制
+ 相似的 Policy Delta
```

合并前必须同时搜索矛盾证据。如果后续 Moment 只在更窄的前提下支持原经验，应缩小 `applicability`，而不是忽略例外。

只有当独立 TaskCase 提供了同机制支持时，才可将置信提高为 `reproduced`。同一 root 下的 child/subagent trajectory 和同一任务内的多次重试都不是独立复现。

### 7.8 阶段 H：产生运行报告

最终报告至少包含：

- 扫描范围与输入 hash；
- 高信号 LearningMoment；
- 本次生成和去重的 LearningProposal；
- 每条提案的支持 EvidenceRef；
- 被质量门槛拒绝的窗口及原因；
- `workspace_fact`、`anchor_candidate`、`skill_candidate`、`system_issue` 的旁路发现；
- no-proposal TaskReview 数量和主要原因；
- 轨迹字段缺口与 Reviewer 不确定性。

## 8. 置信、矛盾与修订

### 8.1 置信层级

| 层级 | 条件 |
| --- | --- |
| `hypothesis` | 只有推断，或有行动变化但缺少修正后的明确结果证据 |
| `observed` | 至少一个 LearningMoment 完整包含反馈、策略变化与修正后证据 |
| `reproduced` | 至少两个独立 TaskCase 在兼容的适用条件下支持同一机制和策略差分，且无未处理的高信反证 |

这些层级不表示永久真理。`reproduced` 仍可被新证据限制、降级或取代。

### 8.2 矛盾处理

Reviewer 不通过投票数量简单消除矛盾，而是先判断：

- 两条证据是否处于不同前提或环境；
- 是否存在版本、工具、模型或 workspace 差异；
- 原经验是否缺少 `excludes` 或过度泛化；
- 新证据是直接反驳机制，还是只证明本次执行失败。

处理方式包括：

- 缩小适用条件；
- 补充排除条件；
- 降低置信；
- 生成新 revision 并将旧版标记为 `superseded`；
- 保留冲突，等待更多证据。

### 8.3 追加修订，不就地改写历史

一条经验被限制或推翻时，创建新 revision，并保留原版本及其当时的证据。

```text
Experience v1
  ├── supported_by Moment A
  ├── supported_by Moment B
  ├── contradicted_by Moment C
  └── superseded_by Experience v2
```

这使知识的变化本身也可审计，后续才有可能讨论过期、降权、召回和注入。

## 9. 运行形态

### 9.1 手动执行

当前实现采用独立 CLI 子命令和独立 `ReviewerSession`。它在产品与执行能力上是一等模式，并直接复用 KernelLoop；实现上不把 `reviewer` 塞入普通用户对话的 `SessionMode` union，防止 `--mode reviewer` 意外继承 Agentic/Auto 路由。其 canonical trajectory 的 mode 字段明确为 `reviewer`。

```bash
meta-agent reviewer run --all
meta-agent -w <path> reviewer run
meta-agent reviewer run --since 7d
meta-agent reviewer run --trajectory <id>
meta-agent reviewer run --all --max-cases 20 --max-turns-per-case 12 --max-budget-usd 5
meta-agent reviewer run --force
meta-agent reviewer reports
meta-agent reviewer report <taskReviewId>
meta-agent reviewer list --status pending
meta-agent reviewer show <proposalId>
meta-agent reviewer review
meta-agent reviewer approve <proposalId> --note "人工复核说明"
meta-agent reviewer reject <proposalId> --reason "拒绝原因"
meta-agent reviewer candidates
```

默认行为：

- 只读一个闭合 TaskCase snapshot；Reviewer 工具不能访问 case 外 trajectory，也不能修改 workspace；
- 默认选择最近 20 个 TaskCase，可用 `--limit` 调整；按 `caseId + inputHash + analyzerId` 增量跳过，提案身份不绑定 inputHash；
- `--all` 表示所有符合资格的 TaskCase，不表示全量原文同时进入模型；
- `--max-cases` 限制 Kernel ReviewerSession 数量，`--max-turns-per-case` 限制每 case 的多轮调查，`--max-budget-usd` 限制整次 run 成本；
- `--force` 只重审没有 Proposal 的已完成 TaskCase；已有 Proposal（包括 rejected）的 case 仍跳过；
- 生成完整 TaskReview、可能为空的 pending Proposal、run manifest 和人工可读报告；
- 只有后续人工批准才写 Candidate；
- 不写入 ExperienceStore 或 pending review 队列。

### 9.2 输出产物

Reviewer 使用 `META_AGENT_HOME/reviewer` 独立存储域：

```text
reviewer/
  task-reviews/<taskReviewId>.json
  proposals/<proposalId>.json
  candidates/<candidateId>.json
  runs/<runId>/
    manifest.json
    report.md
    analysis/<caseId>.raw-response.txt  # 仅失败时，已二次脱敏
```

任务级 `manifest.json` 记录 TaskCase 输入 hash、Kernel turn/tool/cost、TaskReview、质量拒绝和分析故障。任务级 Proposal fingerprint 使用 `analyzerId + caseId + findingId`，不绑定会随轨迹增长变化的 inputHash，也不依赖模型输出数组顺序；legacy window proposal 继续保持旧身份算法。Proposal 新增、批准和拒绝共用同一把状态锁。Candidate 只由人工批准生成，并且仍只属于 Reviewer 域，不会被现有知识召回链消费。

### 9.3 隐私与资格

全局扫描不等于无条件跨 workspace 复制原始内容。一期至少遵守：

- 只扫描当前用户可读的 canonical trajectory；
- 元数据可全局盘点，原始消息、diff 和工具输出只通过 TaskCase 内的有界工具按需读取；
- 证据行和 `taskSummary` 都在进入模型与落盘前执行密钥脱敏；`taskSummary` 额外隐藏 workspace、home 和绝对路径；不复制完整敏感工具输出；
- 跨 workspace 综合优先保留抽象化机制和 EvidenceRef，不复制项目内容；
- 缺少资格或隐私状态的 trajectory 记为 skipped，不默认猜测授权。

## 10. Reviewer 提示契约

Reviewer 不应收到“总结这些轨迹中的经验”这类宽泛任务。提示契约应强制它：

1. 先用工具理解 TaskCase 拓扑、目标和成功标准；
2. 区分 Agent 实际看到的事实、从行动推断的信念、Reviewer 推断和未知项；
3. 重建关键决策链，而不是复述全部工具调用；
4. 不接受 Agent 最终声明作为完成证据，逐条检查成功标准；
5. 分别评估 effectiveness、reliability、stability、efficiency，每个关键声明引用 EvidenceRef；
6. trigger hint 只用于导航，不能因为“人类说过”就自动提升重要性；
7. 领域 bug、参数、文件和命令只能作为证据；Finding 必须表述上层解决方法或判断机制；
8. 显式审计指标降级、proxy completion、静默吞错和其他“没解决却说解决”的行为；
9. 长周期任务逐项检查信息遗漏、遗忘、噪声累积和目标偏移；
10. ExperienceDraft 必须包含 cue、policy delta、mechanism、verification 和 boundary；
11. 不得为了产出数量而强行泛化；没有高价值学习时明确给出 `noProposalReason`；
12. 默认拒绝口号、常识、事后合理化、领域知识摘录和任务流水账。

建议将模型输出约束在对应 schema 中，不从自由文本中二次嗅探结构化字段。

## 11. 第一版实现范围

### 11.1 已实现的核心闭环

- 手动启动的 reviewer run；
- root + child/subagent TaskCase 聚合、范围选择和 input hash；
- 基于 KernelLoop 的隔离 ReviewerSession 及其可审计 reviewer trajectory；
- case overview、ordinal read、literal search、trigger context 四个只读证据工具；
- 目标/观察/决策/结果/四维评估 + 五项过程审计 + 方法论 Finding 组成的 `TaskReview 2.0`；
- 重复错误、失败 evaluation、human correction 等 trigger hints；
- 跨 TaskCase 成员的 EvidenceRef 宿主校验；
- critical/major 高价值 Finding 门槛、稳定 fingerprint 与去重；
- 人工 approve / reject / skip 和幂等 Candidate 物化；
- 质量门槛与合法的 no-proposal TaskReview；
- 人工可读 `report.md`。

### 11.2 后续增量

- 更完整的 EpisodeIndex；
- graph journal 和 artifact 专用只读工具；
- 隔离 worktree 中的显式主动验证工具；
- 从自由文本中可靠识别人类 correction；
- 重复失败之后“策略改变并成功”的确定性链路识别；
- 跨轨迹相似 Proposal 聚类、矛盾检索与 revision；
- 宿主确定性计算 TaskReview 四维评估与 Proposal 三维 impact 指标。

### 11.3 明确不做

- 自动写入 ExperienceStore 或现有 pending 队列；
- 自动召回或注入 Agent 上下文；
- 修改 Graph、Prompt、Skill、tool policy 或 model routing；
- 自动生成 Principle；
- 使用单一 reward 或单一总分给经验排名；
- 对 ExperienceCandidate 做自动晋升、过期、删除或合并写入；
- 用 Reviewer 结论回写或篡改 canonical trajectory。

### 11.4 验收标准

1. 每个 LearningMoment 都能定位到存在的 trajectory ordinal，不得有悬空引用。
2. 确定性预扫描的结果可重建，相同输入不因模型变化而改变。
3. TaskCase 中没有高价值 Finding 时，Reviewer 仍生成 TaskReview，并稳定输出 no proposal。
4. 候选经验均能说明适用信号、具体策略改变、验证方法和排除条件。
5. 单个 TaskCase（无论包含多少 child trajectory）不得标记为 `reproduced`。
6. 合并或提高置信前必须搜索矛盾证据。
7. Reviewer run 对生产任务、正式知识库和 Graph 运行时无写入副作用。
8. 报告显示候选和拒绝结果，不只展示“看起来很好”的候选。
9. AI 分析完成后 Candidate 数量仍为零；只有人工 approve 才能使其增加。
10. Reviewer 作为独立 Kernel profile 运行，不被现有 Agent、Loop、robotics knowledge 路径隐式调用；其只读工具不能越过 TaskCase 边界。

## 12. 与现有系统的关系

### 12.1 trajectory

canonical trajectory 是 Reviewer 的事实来源。Reviewer 的 LearningMoment、LearningProposal、ExperienceCandidate 和 report 不与 trajectory 争夺真相源地位。

Graph journal 继续是 Graph 执行正确性的真相源；Reviewer 只通过 trajectory item 中的 journal sequence 引用必要事件，不将 journal 整体复制成第二份学习轨迹。

### 12.2 现有知识系统

现有知识系统的 ExperienceStore、pending review 与人工审批纪律保持不变。本 Reviewer 的 Proposal 与 Candidate 都只存在于独立 reviewer 存储域，其 schema 也不强行复用现有 `ExperienceEntry`。

原因是两者职责不同：

- ExperienceCandidate 优化证据链、条件化策略和可反驳性；
- ExperienceEntry 是当前知识系统的召回与展示格式。

只有等 Reviewer 产物在真实样本上被证明有用，再单独设计 Candidate → pending ExperienceEntry 的第二道显式编译和人工审批过程。当前这道人工闸门只确认“可以成为 ExperienceCandidate”，不等价于允许进入正式知识系统。

### 12.3 自进化与 Loop Graph

本文暂不设计经验注入、Loop 交互或 meta-agent 自动进化。这些机制以 Reviewer 是否能产出稳定、可审计、有实际决策价值的 ExperienceCandidate 为前置条件。

后续不论经验被注入 Agent prompt、工具召回、persistent Lane 还是 Loop Graph，都不应反向迫使 Reviewer 放宽证据和质量门槛。

**两条必须在注入设计之初就成立的约束**（详见[轨迹数据利用与进化算法选型](./轨迹数据利用与进化算法选型.md)）：

1. **注入必须带 provenance**。轨迹要记录本次运行注入了哪些经验条目及其版本。一旦经验进入 prompt 却没有这条记录，后续轨迹就被污染——效果来自经验还是来自任务本身更简单，将无法分辨，`ExperienceCandidate` 的实际价值永远无法回答。`mode=reviewer` 的自审排除只挡住了"Reviewer 审自己"，没有挡住"Reviewer 的产出改变了被审对象"，这是两件不同的事。
2. **TaskReview 的四维评估与 Proposal 的三维 impact 不得成为优化目标**。它们是模型自评（连同 `candidateEligible` / `significance` / `abstractionLevel` 三项晋升字段也是自述），只能用于人工审核排序与失败聚类。任何后续的自动优化只能以确定性验证信号为主 reward。

## 13. 待实践回答的问题

以下问题保留给实现和真实轨迹样本，不在纸面上预先固定：

1. 多大的 ordinal 窗口能在不丢失因果链的前提下控制 token？
2. 重复错误签名应在哪一层归一化：工具层、trajectory projector 还是 Reviewer pre-scan？
3. Completion Reviewer 的 critique 中哪些是事实反馈，哪些仍是 LLM 观点？
4. 人类纠正在现有 trajectory 中是否有足够明确的结构，还是需要新的 feedback item？
5. 跨 workspace 聚类所需的最小脱敏表示是什么？
6. `ExperienceCandidate` 与现有 `ExperienceEntry` 的边界经真实评审后是否需要收敛？
7. TaskReview 四维评估和 Proposal 三维 impact 的哪些部分可以由宿主确定性计算，哪些必须保留为审阅意见？
8. 聚类和矛盾分析是一次全局运行，还是按持久聚类索引增量运行？

## 14. 一期的最小成功定义

第一版不以“产出了多少经验”作为成功标准。成功意味着：

1. 系统能把 root、child/subagent 和多次 run 还原成一个完整 TaskCase，并回答 Agent 看到了什么、如何行动、实际是否解决。
2. 每份 TaskReview 都显式给出成功标准与 effectiveness、reliability、stability、efficiency 四维判断；观察和推断都能沿 EvidenceRef 回到原始轨迹。
3. Reviewer 能区分一次偶然完成与可重复、可验证的稳定完成，并指出更快或更稳的高价值改进路径。
4. 只有 critical/major 且 abstractionLevel 为 task_family/cross_task 的方法论 Finding 才能生成 LearningProposal；具体领域发现只作为证据。
5. 无高价值经验的 TaskCase 可以合法地产出 no-proposal TaskReview，不以提案数量作为目标。
6. Reviewer 自身的模型推断、不确定性、工具调查轨迹和质量拒绝记录同样可见、可评审。

只有这些条件在真实样本上成立，才进入下一个问题：这些已经过第一道人工审核的 ExperienceCandidate，应该如何经独立的发布流程进入正式知识系统，又如何被 Agent 或 Loop 按需召回。
