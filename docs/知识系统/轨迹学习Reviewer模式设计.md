# 轨迹学习 Reviewer 模式设计

> 状态：设计草案（第一版范围待实现）
>
> 日期：2026-08-23
>
> 依赖：canonical trajectory 及其 ordinal、轨迹身份和证据引用能力
>
> 相关文档：[`meta-agent-自进化方案.md`](../reviews/meta-agent-自进化方案.md)、[`meta-agent-迭代计划-2026H2.md`](../reviews/meta-agent-迭代计划-2026H2.md)、[知识系统 v1](./知识系统v1-经验与锚点.md)

## 0. 执行摘要

`reviewer` 模式是一个由人手动启动的、只读的轨迹学习模式。它扫描 Agent 轨迹，识别真实反馈促成的决策变化，并将它们编译成有证据、可复用、可验证、可被未来证据推翻的经验候选。

这一阶段的目标不是让 meta-agent 自动修改自己，而是先建立一个可靠的“从实践中学习”抽象层。

Reviewer 的核心产物不是轨迹摘要，而是：

> 下一次遇到什么情境或信号时，Agent 应该改变哪个判断或动作，为什么，以及如何验证这条经验仍然成立。

一期约束：

- 逻辑上可扫描全部有资格的 trajectory，物理上采用分层索引、候选窗口和按需读取，不将全部原始轨迹塞入一次模型调用。
- 只有在真实反馈促成了预期、判断或行动的变化时，才产生经验候选。
- 大多数轨迹可以合法地得出 `no_learning`，不追求产出数量。
- 每个结论必须引用 trajectory ordinal 或 graph journal sequence；没有证据的泛化不得写入候选。
- Reviewer 只写独立的 review artifacts，不写正式 ExperienceStore，不修改 Prompt、Graph、Skill 或正在运行的 Agent。
- 第一版聚焦“可靠、稳定、能干事”三个目标，不引入自动注入、自动晋升或自动进化闭环。

## 1. 定位与边界

### 1.1 与任务 Reviewer 区分

meta-agent 中已经存在面向当前任务结果的 Reviewer。为避免语义混淆，本文内部使用两个名称：

| 角色 | 审查对象 | 问题 | 产物 |
| --- | --- | --- | --- |
| Completion Reviewer | 当前 Worker 的任务结果与证据 | 这次任务是否真的完成 | pass / reject / critique |
| Learning Reviewer | 一条或多条已发生的 Agent 轨迹 | 哪个实践反馈值得改变未来决策 | LearningMoment / ExperienceCandidate |

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

### 1.3 三个目标维度

Reviewer 不使用单一总分表示经验价值，而是分别记录它对三个目标的影响。

| 维度 | 定义 | 典型改善 |
| --- | --- | --- |
| 可靠 Reliability | 产出是否真正满足用户目标，完成声明是否有足够证据 | 更好的验收、更少 false success、更准确的错误归因、更安全的操作 |
| 稳定 Stability | 多次运行是否表现一致，是否减少振荡、原样重试和偶然上下文依赖 | 更少重复失败、更明确的恢复条件、更低方差、更可预期的资源消耗 |
| 能干事 Effectiveness | 是否真正扩展解决问题的能力，或以更少时间和成本完成同等质量的工作 | 更好的工具选择、更有效的问题分解、新的可行策略、更短的有效路径 |

## 2. 总体模型

Reviewer 使用两层核心抽象：

```text
canonical trajectory / graph journal
                │
                ▼
          EpisodeIndex
     确定性事实与异常索引
                │
                ▼
         LearningMoment
       一次值得学习的实践片段
                │
                ▼
       ExperienceCandidate
  从一个或多个 Moment 得到的策略差分
                │
                ▼
  cluster / contradiction / revision
                │
                ▼
          ReviewReport
```

`LearningMoment` 是事件层：尽可能忠实地重建发生了什么。

`ExperienceCandidate` 是决策层：明确说出未来哪个行为应该发生改变。

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

### 3.2 ReviewerRunManifest

每次手动执行产生一个独立 run：

```ts
interface ReviewerRunManifest {
  schemaVersion: 'trajectory-review-run-1.0'
  runId: string
  createdAt: number
  scope: {
    trajectoryIds?: string[]
    workspaceIds?: string[]
    modes?: string[]
    createdAfter?: number
    createdBefore?: number
  }
  cursors: Record<string, number>
  inputHashes: Record<string, string>
  reviewerProfile: {
    provider?: string
    model?: string
    promptVersion: string
  }
  stats: {
    trajectoriesScanned: number
    candidateWindows: number
    learningMoments: number
    experienceCandidates: number
    noLearningEpisodes: number
  }
}
```

Manifest 保证同一输入和 Reviewer 版本可对账，也使后续能够识别是轨迹变了，还是 Reviewer 自己变了。

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

### 4.3 一期必做的 Moment

第一版只对三类高信号实现完整链路：

1. **Reviewer correction**：Completion Reviewer 驳回了 Worker 未意识到的缺口，且后续有修正证据。
2. **Repeated failure 后策略改变并成功**：相同失败签名至少重复一次，之后行动发生实质改变，并出现确定性成功证据。
3. **Human correction**：人类明确纠正了 Agent 的事实、判断、动作或完成声明。

`expectation_mismatch`、`breakthrough`、`contradiction` 和 `transferable_pattern` 先保留在 schema 中，等一期证据链跑通后再开放自动发现。

## 5. ExperienceCandidate 建模

### 5.1 核心定义

经验不是一段“知识文本”，而是一条条件化的策略差分：

```text
适用情境 Context
+ 触发信号 Cue
+ 策略差分 Policy Delta
+ 原因机制 Mechanism
+ 验证方法 Verification
+ 适用边界 Boundary
+ 证据 Evidence
```

一条经验的最小价值是：它能让未来 Agent 在行动之前识别适用情境，并改变一个具体判断或动作。

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

interface ExperienceCandidate {
  schemaVersion: 'experience-candidate-1.0'
  id: string
  revision: number
  status: 'candidate' | 'approved' | 'rejected' | 'superseded'

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
  supersedes?: string
}
```

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

每条 ExperienceCandidate 必须通过以下门槛：

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

一期只对 `experience_candidate` 生成完整 schema，其他路由只记录类型、理由和 EvidenceRef，不立即打通其下游系统。

## 7. Reviewer 执行流程

### 7.1 阶段 A：轨迹盘点

根据手动指定的范围列出 trajectory，读取元数据、模式、workspace、父子关系、run 边界和 terminal 状态。

“扫描全部轨迹”的含义是所有符合资格的轨迹都进入盘点，不是将全部消息和工具输出一次性读入模型上下文。

### 7.2 阶段 B：确定性预扫描

优先由程序提取 EpisodeIndex：

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

预扫描不做语义总结，只产生可重建的事实和候选窗口。

### 7.3 阶段 C：候选窗口生成

一期候选窗口由确定性规则产生：

- Completion Reviewer reject 前后的 ordinal 窗口；
- 同一错误签名第一次、再次出现以及最终策略切换的窗口；
- human correction 消息、approval 与之后验证的窗口。

每个窗口包含触发点前后有界的 ordinal，并允许 Reviewer 按 EvidenceRef 再向外读取少量必要上下文。

### 7.4 阶段 D：LearningMoment 重建

Reviewer 对每个窗口依次回答：

1. 当时真正面对的情境是什么？
2. Agent 当时明确声明或隐含预期了什么？
3. 它采取了什么关键行动？
4. 哪条真实反馈否定、限制或支持了原判断？
5. 后来改变的是假设、策略、步骤、工具选择还是验收标准？
6. 修正后是否有新的结果证据？

无法建立反馈与决策变化之间联系的窗口标记为 `no_learning`。

### 7.5 阶段 E：单轨迹经验候选

从同一 trajectory 的一个或多个 LearningMoment 中提出 ExperienceCandidate。单轨迹候选最高只能是 `observed`，不得标记为 `reproduced`。

输出之前必须运行第 6 节的质量门槛。未通过的产物保留拒绝原因，但不进入候选集。

### 7.6 阶段 F：跨轨迹聚类与矛盾分析

聚类优先使用三个语义要素，不只使用表面关键词：

```text
相似的 Cue
+ 相似的失败或成功机制
+ 相似的 Policy Delta
```

合并前必须同时搜索矛盾证据。如果后续 Moment 只在更窄的前提下支持原经验，应缩小 `applicability`，而不是忽略例外。

只有当独立 trajectory 提供了同机制支持时，才可将置信提高为 `reproduced`。相同轨迹内的多次重试不是独立复现。

### 7.7 阶段 G：产生人工审阅报告

最终报告至少包含：

- 扫描范围与输入 hash；
- 高信号 LearningMoment；
- ExperienceCandidate 及其三维影响；
- 每条候选的支持和矛盾 EvidenceRef；
- 被质量门槛拒绝的典型候选及原因；
- `workspace_fact`、`anchor_candidate`、`skill_candidate`、`system_issue` 的旁路发现；
- `no_learning` 数量和主要原因；
- 轨迹字段缺口与 Reviewer 不确定性。

## 8. 置信、矛盾与修订

### 8.1 置信层级

| 层级 | 条件 |
| --- | --- |
| `hypothesis` | 只有推断，或有行动变化但缺少修正后的明确结果证据 |
| `observed` | 至少一个 LearningMoment 完整包含反馈、策略变化与修正后证据 |
| `reproduced` | 至少两条独立 trajectory 在兼容的适用条件下支持同一机制和策略差分，且无未处理的高信反证 |

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

建议的产品形态是独立模式或 CLI 命令，最终命名在实现时决定：

```bash
meta-agent reviewer learn --all
meta-agent reviewer learn --workspace <path>
meta-agent reviewer learn --since <time>
meta-agent reviewer learn --trajectory <id>
meta-agent reviewer learn --full-rebuild
```

默认行为：

- 只读 canonical trajectory 与必要的 graph journal 引用；
- 先从已持久 cursor 增量扫描；
- `--all` 表示所有符合资格的轨迹，不表示全量原文同时进入模型；
- 输出 review artifacts 和人工可读报告；
- 不写入 ExperienceStore 或 pending review 队列。

### 9.2 输出产物

每个 reviewer run 使用独立目录，具体持久路径由实现阶段决定，逻辑结构为：

```text
reviewer-runs/<runId>/
  manifest.json
  episode-index.jsonl
  learning-moments.jsonl
  experience-candidates.jsonl
  rejected-candidates.jsonl
  report.md
```

`episode-index.jsonl` 和中间候选可以删除重建；`manifest.json` 记录输入边界和 hash；在没有后续晋升流程前，所有 ExperienceCandidate 都只是 reviewer run artifact。

### 9.3 隐私与资格

全局扫描不等于无条件跨 workspace 复制原始内容。一期至少遵守：

- 只扫描当前用户可读的 canonical trajectory；
- 元数据可全局盘点，原始消息、diff 和工具输出按候选窗口读取；
- 不将密钥、token、未脱敏环境变量或完整敏感工具输出复制到 review artifacts；
- 跨 workspace 综合优先保留抽象化机制和 EvidenceRef，不复制项目内容；
- 缺少资格或隐私状态的 trajectory 记为 skipped，不默认猜测授权。

## 10. Reviewer 提示契约

Reviewer 不应收到“总结这些轨迹中的经验”这类宽泛任务。提示契约应强制它：

1. 先恢复反馈发生前的情境、预期和动作；
2. 区分轨迹明示事实、从行动推断的预期和 Reviewer 解释；
3. 只在真实反馈导致判断或行动变化时创建 LearningMoment；
4. 每个关键声明都引用 EvidenceRef；
5. ExperienceCandidate 必须包含 cue、policy delta、mechanism、verification 和 boundary；
6. 不得为了产出数量而强行泛化；
7. 没有足够证据时输出 `no_learning`；
8. 默认拒绝口号、常识、事后合理化和任务流水账。

建议将模型输出约束在对应 schema 中，不从自由文本中二次嗅探结构化字段。

## 11. 第一版实现范围

### 11.1 必做

- 手动启动的 reviewer run；
- trajectory 范围选择、持久 cursor 和 input hash；
- 确定性 EpisodeIndex；
- Reviewer correction、repeated failure 后策略改变并成功、human correction 三类候选窗口；
- `LearningMoment` 结构化产物及 EvidenceRef 校验；
- 单轨迹 `ExperienceCandidate`；
- 跨轨迹相似候选聚类和矛盾检索；
- 质量门槛、拒绝原因与 `no_learning`；
- 人工可读 `report.md`。

### 11.2 明确不做

- 自动写入 ExperienceStore 或现有 pending 队列；
- 自动召回或注入 Agent 上下文；
- 修改 Graph、Prompt、Skill、tool policy 或 model routing；
- 自动生成 Principle；
- 使用单一 reward 或单一总分给经验排名；
- 对 ExperienceCandidate 做自动晋升、过期、删除或合并写入；
- 用 Reviewer 结论回写或篡改 canonical trajectory。

### 11.3 验收标准

1. 每个 LearningMoment 都能定位到存在的 trajectory ordinal，不得有悬空引用。
2. 确定性预扫描的结果可重建，相同输入不因模型变化而改变。
3. 轨迹中没有高信号反馈时，Reviewer 能稳定输出 `no_learning`。
4. 候选经验均能说明适用信号、具体策略改变、验证方法和排除条件。
5. 单轨迹经验不得标记为 `reproduced`。
6. 合并或提高置信前必须搜索矛盾证据。
7. Reviewer run 对生产任务、正式知识库和 Graph 运行时无写入副作用。
8. 报告显示候选和拒绝结果，不只展示“看起来很好”的候选。

## 12. 与现有系统的关系

### 12.1 trajectory

canonical trajectory 是 Reviewer 的事实来源。Reviewer 的 EpisodeIndex、LearningMoment、ExperienceCandidate 和 report 都是可重建投影，不与 trajectory 争夺真相源地位。

Graph journal 继续是 Graph 执行正确性的真相源；Reviewer 只通过 trajectory item 中的 journal sequence 引用必要事件，不将 journal 整体复制成第二份学习轨迹。

### 12.2 现有知识系统

现有知识系统的 ExperienceStore、pending review 与人工审批纪律保持不变。本 Reviewer 产出的 `ExperienceCandidate` 首先只存在于 reviewer run artifacts，其 schema 也不强行复用现有 `ExperienceEntry`。

原因是两者职责不同：

- ExperienceCandidate 优化证据链、条件化策略和可反驳性；
- ExperienceEntry 是当前知识系统的召回与展示格式。

只有等 Reviewer 产物在真实样本上被证明有用，再单独设计 Candidate → pending ExperienceEntry 的显式编译和人工审批过程。

### 12.3 自进化与 Loop Graph

本文暂不设计经验注入、Loop 交互或 meta-agent 自动进化。这些机制以 Reviewer 是否能产出稳定、可审计、有实际决策价值的 ExperienceCandidate 为前置条件。

后续不论经验被注入 Agent prompt、工具召回、persistent Lane 还是 Loop Graph，都不应反向迫使 Reviewer 放宽证据和质量门槛。

## 13. 待实践回答的问题

以下问题保留给实现和真实轨迹样本，不在纸面上预先固定：

1. 多大的 ordinal 窗口能在不丢失因果链的前提下控制 token？
2. 重复错误签名应在哪一层归一化：工具层、trajectory projector 还是 Reviewer pre-scan？
3. Completion Reviewer 的 critique 中哪些是事实反馈，哪些仍是 LLM 观点？
4. 人类纠正在现有 trajectory 中是否有足够明确的结构，还是需要新的 feedback item？
5. 跨 workspace 聚类所需的最小脱敏表示是什么？
6. `ExperienceCandidate` 与现有 `ExperienceEntry` 的边界经真实评审后是否需要收敛？
7. 三维 impact 的哪些部分可以由宿主确定性计算，哪些必须保留为审阅意见？
8. 聚类和矛盾分析是一次全局运行，还是按持久聚类索引增量运行？

## 14. 一期的最小成功定义

第一版不以“产出了多少经验”作为成功标准。成功意味着：

1. 对一组包含明确 Reviewer 驳回、重复失败和人类纠正的真实轨迹，系统能找到对应的高信号 LearningMoment。
2. 每个 Moment 都能沿 EvidenceRef 回到原始反馈、行动和修正结果。
3. 产生的经验能让人清楚回答“下次什么时候改变哪个决策”，而不是只复述发生了什么。
4. 无学习价值的轨迹不会被强行包装成经验。
5. Reviewer 自身的模型推断、不确定性和拒绝记录同样可见、可评审。

只有这些条件在真实样本上成立，才进入下一个问题：这些 ExperienceCandidate 应该如何经人工审批进入正式知识系统，又如何被 Agent 或 Loop 按需召回。
