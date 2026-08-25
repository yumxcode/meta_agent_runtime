# meta-agent 自进化方案

> 状态：机制版 v3（治理与门槛部分待冻结）
>
> 日期：2026-08-24（v2：2026-08-22）
>
> 依赖：A3-M1～M4 标准轨迹、A3-M5 可信切读与 replay parity、Reviewer 模式的 TaskCase / TaskReview
>
> 参考：*Next-Generation Agentic Reinforcement Learning Systems Enable Self-Evolving Agents*（arXiv:2607.01120）及 2024～2026 年自进化 Agent 一手工作
>
> **分工声明**：本文是**治理主文档**，负责评测独立性、风险分级、晋升与回滚门槛、数据契约。
> 「优化对象如何分层、选什么算法、reward 怎么设计、先做哪一步」以
> [轨迹数据利用与进化算法选型](../知识系统/轨迹数据利用与进化算法选型.md) 为准；两文冲突时以该文为准。

## 0. 执行摘要

meta-agent 自进化的北极星不是“自动生成更多 Skill / Memory”，也不是“Agent 直接修改自己”，而是：

> **持续优化一套模型无关的可靠性机制，使不同能力、不同版本的 LLM 接入后，都能更稳定、可验证、可恢复地完成真实任务。**

它本质上是对 Agent Runtime 的持续自动设计与实证，而不是对单个 prompt、Skill 或模型的局部调参。第一阶段应构建以下受治理闭环：

```text
canonical trajectory
        ↓
可学习 episode 与延迟反馈
        ↓
失败归因与进化控制平面
        ↓
候选可靠性机制：任务契约 / 状态 / 上下文 / 验证 / 恢复 / 路由
        ↓
replay + held-out regression + safety evaluation
        ↓
shadow → canary → promotion / rollback
```

核心结论：

1. **A3-M5 保持现有语义**：它解决可信读取、回放和兼容迁移，不直接承诺自动进化。
2. **自进化是 M5 之上的独立 evolution track**，共用 A3 的身份、ordinal、父子关系、证据和隐私契约。
3. **进化的主对象是可靠性机制**：优先顺序为 Task Contract / Evidence Verifier / Task State / Context Compiler / Progress & Recovery → orchestration / model adaptation → Skill / Memory / Prompt 产物 → agent architecture / model weights。这是"改哪个机制"的排序；"用什么手段改"是另一条正交的轴（L0–L4），两者的对应关系见 §4.1。
4. **Skill 和 Memory 是可替换载体，不是终极目标**：应当优化何时生成、写入、召回、验证、过期和淘汰它们的机制。
5. **进化不能绕过评测独立性**：被评 Agent 不得修改 evaluator、held-out 数据、权限策略和晋升规则；false success 应是核心可靠性指标。
6. **A3 已从纯审计级迈入准学习级**：0.9.3 起生产链路已发射真实 `evaluation`（auto_verify 逐轮 pass/fail）、贯通 `decidedBy='human'` 的人工审批来源、可识别 `isSteering` 纠偏，并由 Reviewer 模式产出以 TaskCase 为边界的 TaskReview。仍缺的是延迟 reward 回流、精确 replay envelope、机制版本注册、**离线回放评测集**与**经验注入 provenance**（见 §6.2 缺口 G / H）。
7. **权重级 RL 在当前架构下没有落点**：meta-agent 是 API 客户端，模型参数与 rollout 基础设施都不在我们手里。可优化对象必须先分层，L0～L2（参数阈值 / 上下文 playbook / workflow 归纳）不涉及任何训练且应先做完；权重训练需要引入 open-weight 底座，属于最后一步。分层定义见[算法选型文档](../知识系统/轨迹数据利用与进化算法选型.md) §2。
8. **自评分数不得作为优化目标**：`TaskReview.assessment` 的四维评分是本系统自产的 LLM 自评，只能用于人工审核排序与失败聚类，禁止用作 reward（见 §8.5）。

## 1. 范围与边界

### 1.1 好 Agent 的判定标准

一个好的 Agent 应在接入 LLM 后，对广泛真实任务展示以下性质：

| 维度 | 问题 | 建议核心指标 |
| --- | --- | --- |
| 能力覆盖 | 能解决多少类不同任务 | task-family coverage、pass@1 |
| 正确性 | 结果是否真正满足用户目标 | verified correctness、最终验收率 |
| 稳定性 | 同一任务重复运行是否持续成功 | 全部 k 次均通过的比率、方差、低分位表现 |
| 鲁棒性 | 更换模型、provider、workspace 或发生工具错误后是否仍有效 | 跨模型方差、扰动成功率 |
| 可靠性 | 能否识别证据不足，避免错误宣称完成 | false-success rate、校准度、失败恢复率 |
| 效率与安全 | 成本、时间、权限和副作用是否可控 | cost / success、latency、安全违规、人工介入率 |

不使用单一平均分判断 Agent。评估矩阵应是：

```text
任务分布 × 模型 / provider × 随机种子 × 环境扰动 × Agent 版本
```

优化时同时关注平均成功率、最差分位、false success、回归、成本和安全硬约束。一个能够明确识别“尚无足够证据”并主动补证或升级的 Agent，比一个高频错误宣称成功的 Agent 更可靠。

### 1.2 本方案中的“自进化”

自进化指：已部署 Agent 能从过去的受管控经验中得到可验证的候选改进，并通过版本化、回放、回归、灰度和回滚影响未来行为。

优先的机制更新包括：

- 改进任务契约、验收指标和证据计划生成；
- 改进长任务状态写入、保留、过期、冲突和上下文选择；
- 改进进度检测、目标漂移检测、失败恢复、终止和升级机制；
- 根据模型能力动态选择脚手架、thinking budget、subagent 与验证深度；

机制管理的外置产物包括：

- 写入、修订或过期一条 memory；
- 新增或修改一个 Skill / workflow / verifier rubric；
- 修改 system prompt、developer prompt、planning template 或 compaction 策略；
- 调整 model/provider 路由、thinking budget、subagent 分配或验证深度；
- 修改 tool description / schema，或将重复 SOP 编译为确定性工具；
- 在隔离环境中搜索 Agent 架构候选；
- 在具备开放权重、训练信号和算力时更新 policy model 权重。

### 1.3 不包含的行为

- 当前运行的生产 Agent 直接覆盖自己的代码或提示词；
- 未经 replay / regression 就将候选更新热切换到用户流量；
- 用单一“完成”状态作为 reward，忽略测试、用户纠正、安全与后续回退；
- 让被评 Agent 自行改写 evaluator、隐藏测试集或晋升阈值；
- 为了“更好的学习”保存 thinking token、密钥、不受限制的工具输出或未获授权的跨 workspace 数据。

## 2. 前沿方案的共识与启示

### 2.1 三层系统底座

*Next-Generation Agentic Reinforcement Learning Systems Enable Self-Evolving Agents* 将企业级自进化拆为三层：

1. **Agent Trajectory Data Protocol（ATDP）**：保存 observation、action、outcome、reward / critique、版本和治理元数据；
2. **Agentic Data Proxy**：将真实工作负载转换成脱敏、可回放、有资格边界的学习数据；
3. **Evolution Control Plane**：根据失败类型、证据、成本和风险决定修改 memory、skill、harness、tool 还是 model weights，也可选择 rollback 或 no-op。

meta-agent 的 A3 已经覆盖第一层的主体骨架；M5 之后的工作重点不是再造一种轨迹，而是补齐“学习资格 + reward / critique + replay + 控制平面”。

### 2.2 当前五类主要路线

| 路线 | 代表工作 | 关键机制 | 对 meta-agent 的启示 |
| --- | --- | --- | --- |
| 外置记忆 / Skill | Memento-Skills、SkillClaw、EvolveR | 从轨迹中蒸馏可读写的程序性经验 | 成本低、可解释，适合作为机制管理的可回滚载体，但不是默认的首个进化目标 |
| Context / Prompt | ACE、GEPA、TextGrad | 自然语言反思、增量 playbook、Pareto 候选 | 不必更新权重，可利用现有轨迹快速试验 |
| Agent 架构 / 代码 | ADAS、Darwin Gödel Machine | 候选档案、开放搜索、benchmark 选择 | 只能在隔离分支和强回归下开放 |
| 自对弈 / 课程 | Agent0、Tool-R0 | curriculum agent 与 solver 共进化 | 适合补足工具使用和极端失败样本，不能代替真实验证 |
| 在线权重更新 | OpenClaw-RL、MetaClaw、AReaL2.0 | next-state signal、PRM、OPD、LoRA / RL | 依赖 token / logprob / checkpoint 和 GPU，应作为后期分支 |

### 2.3 研究结论不能直接外推

2025～2026 年的大量结果仍是 arXiv 预印本，且常在特定 benchmark、模型和 evaluator 上成立。因此本方案只吸收经过多项工作反复出现的系统共识：

- 文本 critique 比单一标量 reward 包含更多可操作信息；
- 外置 memory / skill / context 通常比更新模型权重更便宜、更容易回滚；
- 长周期 Agent 需要过程 reward 和延迟 reward，不能只评价最后一句输出；
- 简单把历史全塞进 context 不是持续学习，可能因不相关经验和上下文膨胀退化；
- 优化目标必须是多维的，并且 evaluator 必须独立于被评 Agent。

## 3. 与 A3-M5 的关系

### 3.1 不重定义 A3-M5

`meta-agent-迭代计划-2026H2.md` 已经把 A3-M5 定义为：在双写稳定一个真实发布周期后，interactive 首先切到公共 model-context projector，auto / robotics 只做 replay parity 实验。

这个定义保持不变，因为它解决的是“新读路径是否与 legacy 等价”，而自进化解决的是“如何从可信轨迹中生成并晋升更好的策略”。两者有先后依赖，但不应合并为一个开关。

### 3.2 新增 evolution track

提议将自进化作为 M5 上层的独立工作流：

| 阶段 | 目标 | 允许改变生产行为吗 |
| --- | --- | --- |
| **E0｜证据就绪** | 完成 M5 parity 观察；补 evaluation / feedback / eligibility / replay 契约 | 否 |
| **E1｜Shadow Mechanism Learner** | 从轨迹构建 episode、做失败归因，产出可靠性机制诊断与候选 | 否 |
| **E2｜可靠性机制进化** | Task Contract、Evidence Verifier、Task State、Context Compiler、Progress / Recovery 候选进入 replay 和人工晋升 | 默认否，审批后是 |
| **E3｜受控自动晋升** | 对 workspace-local、低风险候选开放 canary 与自动回滚 | 受限允许 |
| **E4｜外置产物与架构进化** | 在机制约束下进化 Skill / Memory / Prompt，并隔离搜索 Agent graph、角色、工具封装与运行时代码 | 经强回归和审批后 |
| **E5｜模型权重进化** | SFT / DPO / LoRA / PRM / online RL | 独立训练和发布流程 |

## 4. 可进化的可靠性机制与优先级

| 机制 | 要解决的问题 | 主要学习信号 | 候选实现 | 优先级 |
| --- | --- | --- | --- | --- |
| **Task Contract Compiler** | 用户究竟要什么，哪些声明通过后才能算完成 | 漏验收、过度约束、false success、用户驳回 | 类型化任务契约、完整性检查、版本化 amendment | P0 |
| **Evidence Planner / Verifier** | 需要什么证据，证据是否充分、有效且发生在正确时间 | 确定性检查、后续 CI、人工验收、错误通过 / 错误拒绝 | 证明义务图、独立 verifier、证据充分性评分 | P0 |
| **Task State Ledger** | 月级任务中哪些事实当前仍然为真 | 目标漂移、重复探索、过期假设、park/wake 后遗失 | 类型化 state item、event reducer、冲突/过期/引用关系 | P0 |
| **Context Compiler** | 当前一轮模型必须看什么，怎样既不丢信息也不引入噪音 | 状态消融、context noise、token 成本、恢复后成功率 | pinned invariants + 按需检索 + 反事实消融 | P0 |
| **Progress / Drift / Recovery Controller** | 何时继续、重规划、park、回滚、升级或停止 | 无进展循环、目标漂移、错误恢复率、人工介入 | 状态机、进展估计、异常簇、升级策略 | P0 |
| **Planning / Orchestration** | 如何拆解、排序、并行和分配 subagent | 依赖错误、重复工作、合并冲突、任务时间 | 离线策略评估、规则候选、受约束 bandit | P1 |
| **Model Capability Adapter** | 面对不同 LLM 应使用多少脚手架、思考预算和验证深度 | 跨模型方差、工具构参成功率、长上下文保持、成本 | 能力探针、profile、约束路由与动态 scaffold | P1 |
| **Tool Grounding** | 如何选择工具、构造参数、理解 outcome 并控制副作用 | 选工具/参数错误、结果方差、审批 deny | schema adapter、tool router、确定性封装 | P1 |
| **Skill / Memory / Prompt 产物** | 在上述机制管理下表达可复用知识、流程和上下文 | 召回/注入后的边际改善、噪音、过期和冲突 | 蒸馏、版本化、召回排序、生效范围与 TTL | P2 |
| **Agent architecture** | graph、role、review node、循环和运行时代码 | 稳定 benchmark、历史 replay、隔离 canary | ADAS / DGM 类开放式档案搜索 | P3 |
| **Model weights** | LoRA / checkpoint / reward or process model | token-level 轨迹、logprob、独立 reward、held-out 集 | SFT、DPO、PRM、OPD、online RL | P3 |
| **Evaluator / Guardrail** | rubric、安全策略、审批规则、held-out 数据 | 独立安全审计 | 只允许独立治理流程升级 | 信任根 |

Skill / Memory / Prompt 不被删除，而是从“自进化的中心”降为“可靠性机制所管理的外置产物”。需要进化的是何时产生、何时使用、如何验证、如何过期与如何淘汰它们的策略，而不是产物数量。

### 4.1 与优化对象分层（L0–L4）的关系

本表的优先级与[算法选型文档](../知识系统/轨迹数据利用与进化算法选型.md) §2 的 L0–L4 是**两条正交的轴**，不要互相套用：

- **本表的 P0/P1/P2/P3 回答"该建设 / 改进哪个机制"**，排序依据是对可靠性的因果杠杆。
- **L0–L4 回答"用什么手段去改，代价和风险多大"**，排序依据是实施成本与不可回滚程度。

两者的对应关系：

| 本表机制 | 落在哪一层 | 说明 |
| --- | --- | --- |
| Progress / Drift / Recovery 的阈值 | L0 | 轮数、退避、门限可直接由轨迹统计确定 |
| Task Contract / Evidence Planner / Context Compiler | L1 | 本质是结构化的提示与上下文产物，用反射式演化（GEPA / ACE）优化 |
| Task State Ledger 的 reducer 与保留策略 | L0 + L1 | 字段取舍靠消融统计，表述靠 L1 |
| Planning / Orchestration、Model Capability Adapter、Tool Grounding | L3 | 受约束 bandit + 离线反事实评估 |
| Skill / Memory / Prompt 产物的生成与召回策略 | L1 + L2 | 与 AWM 式 workflow 归纳同层 |
| Model weights | L4 | 需要引入 open-weight 底座才成立 |

因此"P0 机制优先"与"L0～L2 优先"并不冲突：**先按本表选择要改进哪个机制，再按 L0–L4 选择改进它的手段，并且永远从该机制所能落到的最低层开始。**

## 5. 核心可靠性机制设计

### 5.1 Task Contract Compiler：先冻结什么算通过

“指标生成器”应升级为 **Task Contract Compiler**。它不只输出一个标量分数，而是在执行前将用户请求编译为类型化的完成声明和证明义务：

```ts
interface TaskContract {
  contractId: string
  goal: string
  nonGoals: string[]
  constraints: string[]
  assumptions: Array<{
    id: string
    statement: string
    mustVerify: boolean
  }>
  acceptanceClaims: Array<{
    id: string
    claim: string
    evidenceType: 'test' | 'build' | 'inspection' | 'runtime' | 'user'
    check?: string
    threshold?: number
    required: boolean
  }>
  safetyConstraints: string[]
  budget?: { maxCostUsd?: number; maxDurationMs?: number }
  ambiguity: string[]
  escalationConditions: string[]
  version: number
  contentHash: string
}
```

任务流程改为：

```text
用户任务
  ↓
Task Contract Compiler
  ↓
契约完整性 / 可验证性检查
  ↓
高风险或实质歧义 → 用户 / 独立 reviewer 确认
  ↓
冻结 contract hash
  ↓
Evidence Planner 生成证据计划
  ↓
Executor 执行
  ↓
独立 Verifier 逐条核验 acceptance claim
  ↓
完成 / 补证 / 重规划 / 升级
```

契约约束：

- Executor 不得自行降低 acceptance criteria；
- 执行中可追加 versioned amendment，但不就地覆盖旧契约；
- 放宽验收条件必须记录原因，高风险任务需要用户或独立 reviewer 批准；
- Verifier 优先信任测试、编译、运行状态和外部验收等确定性证据；LLM judge 只补充 critique；
- 指标可以在执行中增强，但不能为了宣称成功而静默变弱；
- 契约本身必须受评估：缺失验收、无法执行、过度约束和容易 gaming 都是 contract failure。
- 契约复杂度随任务风险和可逆性调整：简单、低风险任务可自动冻结紧凑契约，高风险或存在实质歧义时才请求用户确认，不能让契约机制本身成为日常使用阻力。

有人工标签的轨迹可用于学习：哪类任务经常遗漏哪些验收项，哪些条件导致 false success，哪些指标被用户驳回，以及不同 task family 应组合什么 verifier。

### 5.2 Task State Ledger 与 Context Compiler：支撑月级任务

长任务必须分离四类数据：

```text
Trajectory   = 发生过什么，不可变审计记录
Task State   = 现在什么仍然为真，当前应继续什么
Context      = 这一轮模型必须看什么
Memory       = 跨任务可复用的知识和经验
```

Task State Ledger 不是另一份对话摘要，而是类型化、可引用的当前任务真相，至少覆盖：

- 目标、non-goals 与不可变约束；
- 已确认需求与 Task Contract version；
- 关键决策及其依据；
- 假设及待验证 / 已证伪 / 已确认状态；
- 当前计划、已完成里程碑与下一步；
- 工件、版本、外部依赖与等待条件；
- 验证证据、证据范围与最后相关 diff；
- 未解决问题、blocker、风险和漂移信号；
- park / wake 条件、预期外部状态变化与恢复入口。

每个 state item 应带有：

```ts
interface TaskStateItem {
  stateId: string
  kind: 'goal' | 'constraint' | 'decision' | 'assumption' | 'artifact'
      | 'evidence' | 'open_loop' | 'blocker' | 'next_action' | 'risk'
  status: string
  value: unknown
  sourceOrdinals: number[]
  scope: string
  confidence: number
  createdAt: number
  lastValidatedAt?: number
  validUntil?: number
  dependsOn?: string[]
  requiredInContext: boolean
}
```

Context Compiler 从 Task State、当前 observation 和必要 memory 生成当前模型视图：

```text
始终注入：用户最终目标、不可变约束、契约、当前阶段、关键 blocker
按需注入：下一步相关决策、工件、证据、领域知识与相关历史失败
默认不注入：已解决过程、重复工具输出、无后续依赖讨论、过期假设和原始长日志
```

compaction 只能改变对话视图，不能破坏 Task State。park / wake 恢复时首先用真实 workspace、checkpoint 和证据校验 state，再生成 resume context，避免将过期状态当作真相。

“中间应该记什么”可以被定义为可学习的信息价值：

```text
V(x) = P(后续需要 x) × 遗漏损失
     - P(x 引入噪音) × 上下文损失
     - 过期 / 错误风险
     - token 与检索成本
```

使用轨迹做反事实消融：在 replay 中分别保留或移除某类 state item，比较后续完成率、重复探索、漂移、成本和错误完成，从而学习 State Write / Retention / Context Selection Policy。

### 5.3 Progress / Drift / Recovery Controller：把 auto 变成可观测控制系统

auto 不能只依赖模型自己感觉“是否还在推进”。控制器至少需要跟踪：

- 任务契约的已证明 / 未证明 / 失败 claim；
- 相对上一 checkpoint 的实际状态进展；
- 重复工具调用、重复错误、无新证据循环和计划反复重写；
- 当前 action 是在减少不确定性，还是只在增加轨迹长度；
- 成本 / 时间 / token / tool error 预算；
- 触发 replan、更换模型、增加 verifier、派 subagent、park、rollback 或请求用户的条件。

这一机制的核心输出不是“分数”，而是下一个控制动作以及它所引用的证据。

### 5.4 Model Capability Adapter：不把 Agent 过拟合给某个 LLM

接入新模型时，meta-agent 应通过小型能力探针和历史轨迹形成 profile：

- 指令遵循和结构化输出能力；
- tool 选择与 schema 构参成功率；
- 长上下文保持与状态恢复能力；
- 代码编辑、错误恢复与自我验证校准度；
- 并行工作与 subagent 合并能力；
- 延迟、成本、限流和 provider 稳定性。

然后动态选择是否要显式计划、验证深度、Skill 注入量、thinking budget、最大自主轮次、subagent 并发度和升级模型。强模型可以使用较轻脚手架，弱模型或高风险任务需要更多护栏和 verifier，而不是所有模型强制使用同一套 prompt 与 Skill。

### 5.5 标注轨迹必须先归因到机制

只标注“成功 / 失败”不足以驱动可靠性进化。至少需要以下机制失败分类：

| 标签 | 含义 | 优先改进的机制 |
| --- | --- | --- |
| `SPECIFICATION_ERROR` | 任务理解、范围或验收标准错误 | Task Contract Compiler |
| `PLANNING_ERROR` | 任务分解、顺序、依赖或资源计划错误 | Planning / Orchestration |
| `STATE_LOSS` | 关键目标、决策、假设或 open loop 丢失 | Task State Ledger |
| `CONTEXT_NOISE` | 无关历史或错误 memory 压制了关键状态 | Context Compiler |
| `TOOL_SELECTION_ERROR` | 选择了错误工具 | Tool Grounding / Model Adapter |
| `TOOL_ARGUMENT_ERROR` | 无法正确构造 schema 参数 | Tool Grounding / Model Adapter |
| `EXECUTION_ERROR` | 环境、工具或外部依赖执行失败 | Recovery / Tool Runtime |
| `EVIDENCE_GAP` | 工作可能正确，但证据不足 | Evidence Planner |
| `FALSE_SUCCESS` | 实际未通过却宣称完成 | Task Contract / Verifier / Termination |
| `VERIFIER_FALSE_REJECT` | 实际正确但被验证器错误拒绝 | Verifier calibration |
| `RECOVERY_FAILURE` | 识别到失败但未能恢复或升级 | Recovery Controller |
| `GOAL_DRIFT` | 过程中偏离用户目标 | State / Drift Controller |
| `BUDGET_FAILURE` | 成本、时间、token 或重试失控 | Budget / Orchestration |
| `COORDINATION_FAILURE` | subagent 重复工作、责任空洞或结论冲突 | Delegation / Merge / Review |
| `MODEL_ADAPTATION_FAILURE` | 对当前模型使用了错误脚手架或预算 | Model Capability Adapter |

有了这些标签，闭环才能从“写一条经验”上升为：

```text
标注轨迹 → 机制失败归因 → 机制级假设 → 代码/配置候选
          → 任务 × 模型 × 扰动矩阵 replay → shadow / canary / rollback
```

## 6. 当前 A3 能力与缺口

### 6.1 已具备的底座

A3-M1～M4 已提供：

- append-only canonical JSONL、严格 ordinal、run / turn 身份；
- session、graph instance、subagent 的 root / parent 关系；
- `message`、`turn_context`、`approval`、`tool_outcome`、`turn_diff`、`compaction`、`state_checkpoint`、`phase`、`knowledge` 等标准 item；
- model / provider、tool schema hash、policy hash、成本、耗时和错误类证据；
- canonical / projection health、verify、reindex、telemetry、parity、父子遍历；
- thinking 删除、凭据脱敏、二进制省略、文本截断和 hash；
- 不切换 graph journal、auto checkpoint 等执行真相源的兼容边界。

此外，0.9.3 的 Reviewer 模式已补齐：

- `evaluation` 的真实发射者（KernelLoop 把 auto_verify 每轮判定写成 `evaluator=auto_verify` 的 pass/fail + round）；
- 人工决策来源贯通（`decidedBy` 从交互守卫经权限策略、工具执行直到事件契约 1.2.0，`human` / `hook` / `policy` 不再被压平）；
- `isSteering` 用户纠偏可被识别为人工纠正信号；
- `TaskCase`（root + child + 多 run 的任务证据边界）与 `TaskReview`（结果判定、逐条成功标准、四维评估、方法论 Finding）；
- 只读、case 封闭的证据工具与 `mode=reviewer` 自审排除。

这些能力足以支持 E1 Shadow Mechanism Learner 的数据读取和证据引用。

### 6.2 从审计级到学习级的缺口

#### 缺口 A｜真实 reward / critique 链路（**已部分关闭**）

原状：`TrajectoryItemSchema` 已定义 `evaluation`，但生产代码没有发射者，真实 auto 轨迹的 evaluation 恒为 0。

现状：0.9.3 起 auto_verify 的逐轮判定已写入 `evaluation`，人工 deny / redirect / steering 也可稳定识别。

仍缺：**延迟反馈回流**（后续 CI、工件回退、任务重开、部署后故障尚未追加为事后 evaluation），以及 §7.2 定义的 `EvaluationAnnotation` 完整字段（evaluator 版本、rubric hash、failureAttributions、independentEvaluator）。

#### 缺口 B｜因果单元（**已部分关闭**）

原状：runId / turnId / toolUseId 只能圈定范围，缺少可引用的学习单元。

现状：**TaskCase 已经是任务级因果单元**——它把同一 root 下的子代理与多次 run 聚成一个证据边界，TaskReview 在其上给出结果判定、逐条成功标准状态与决策链重建，Finding 与 LearningProposal 都强制引用 `trajectoryId + ordinal`。

仍缺：turn / decision 级的细粒度单元。这一层在做 L3 路由 bandit 之前才必要，不必提前建设。

#### 缺口 C｜版本 hash 不等于可回放版本

`turn_context` 保存 tool schema hash 和 policy hash，但尚缺能根据 hash 取回完整产物的 artifact registry。对严格 replay，还需要明确的 prompt / Skill / tool schema / model checkpoint / guardrail / retrieval index / workspace state 版本。

#### 缺口 D｜未区分回放能力

外部 API、真实硬件、不可逆写操作不可能和纯计算工具一样重放。每个 action 或 episode 至少应标记：

- `deterministic`：相同快照和参数可确定性执行；
- `approximate`：可在模拟或新环境中近似回放；
- `non_replayable`：只能使用已记录 outcome 或将其排除出反事实实验。

#### 缺口 E｜学习资格与数据隔离

当前 privacy filter 处理秘密和大字段，但“允许审计”不等于“允许学习”。还需要：

- `trainingEligibility: denied | local_only | workspace | aggregate`；
- data classification、retention policy、数据主体 / workspace；
- 交叉 workspace 聚合和共享 Skill 的显式授权；
- support / candidate-generation / validation / held-out 切分；
- 同一条轨迹不得同时无限制地用于生成改进和证明改进。

#### 缺口 F｜不具备直接在线 RL 的 token 数据

如果未来接 AReaL2.0 / OpenClaw-RL 类权重训练，还需 model checkpoint、token IDs、sampling parameters、logprobs、reward attribution 与 staleness 信息。这些不应在没有明确权重训练路线前强行塞入 A3 canonical schema。

补充：这个缺口**短期内不必填**。meta-agent 作为 API 客户端无法对主模型做权重训练，权重级 RL 只有在为某个窄任务引入 open-weight 底座时才成立，属于 L4（见[算法选型文档](../知识系统/轨迹数据利用与进化算法选型.md) §2）。在 L0～L3 跑通之前投入 token 级数据采集是过早优化。

#### 缺口 G｜没有经验注入 provenance（**新增，阻塞归因**）

一旦 Reviewer 产出的经验开始进入 prompt，后续轨迹即被污染：效果究竟来自注入的经验，还是任务本身更简单，无法分辨。当前轨迹**没有记录本次运行注入了哪些经验 / playbook / workflow 及其版本**。

后果：`ExperienceCandidate` 的"到底有没有用"永远无法回答，所有 A/B 归因不成立，§9 的候选比较失去前提。

建议：复用 `knowledge` item，在注入时追加 `action=inject` 记录 `entryIds` 与版本、选择原因；TaskReview 同时带上"本次注入集合"的引用。

注意这与 `mode=reviewer` 自审排除是两件事：后者只挡住"Reviewer 审自己"，没有挡住"Reviewer 的产出改变了被审对象"。

#### 缺口 H｜没有离线回放评测集（**新增，阻塞一切优化**）

没有 held-out 评测集就没有 fitness function，§8.2 的评测矩阵无法实例化，任何候选都无法证伪。

这是**当前最紧迫的一项**，且优先级高于选择任何算法。最小可行形态与切分规则见[算法选型文档](../知识系统/轨迹数据利用与进化算法选型.md) §4：从已有轨迹中挑选结果判定明确、具备确定性验证证据的 TaskCase 冻结为回放集，20～50 个证据完整的用例即可起步。

## 7. 学习数据契约

### 7.1 Episode Builder

训练和进化消费者不应直接把整条 `trajectory.jsonl` 当作一个样本。Episode Builder 负责在不修改 canonical 的前提下构建派生数据：

> **实现状态**：task episode 这一档**已经由 `TaskCase` 实现**——它按 root / parent 关系聚合同一任务的全部 trajectory 与多次 run，产出稳定 `caseId`、`inputHash` 与只读证据视图，且排除 `mode=reviewer` 自审轨迹。下列其余粒度仍是待建设项，**不要重新发明 task 级切分**。

- ~~task episode~~：已由 `TaskCase` 承担，`caseId = hash(rootTrajectoryId)`；
- session episode：面向长期对话、用户偏好和 memory 更新；
- run episode：面向一次 submit / auto wake 的结果与成本；
- turn / decision episode：面向工具路由、过程 reward 和错误恢复（**做 L3 路由 bandit 之前不必建设**）；
- graph activation episode：面向节点、Lane、subagent 和分支结构评估；
- task family cohort：面向相似任务上的重复失败、技能迁移和分布漂移。

每个派生 episode 至少包含：

```ts
interface LearningEpisodeManifest {
  episodeId: string
  source: Array<{
    trajectoryId: string
    fromOrdinal: number
    toOrdinal: number
  }>
  subject: string
  taskFamily?: string
  taskContractRef?: string
  taskStateCheckpointRefs?: string[]
  artifactVersions: Record<string, string>
  mechanismVersions: Record<string, string>
  replayClass: 'deterministic' | 'approximate' | 'non_replayable'
  split: 'support' | 'validation' | 'held_out' | 'canary'
  trainingEligibility: 'denied' | 'local_only' | 'workspace' | 'aggregate'
  redactionPolicyVersion: string
  createdAt: number
}
```

manifest 只引用 canonical ordinal，不复制或改写原始证据。

除事件切片外，Episode Builder 还应生成**机制归因视图**：把用户标注、确定性结果、Verifier 结论和延迟运维信号归并到同一个 episode，输出第 5.5 节定义的 failure taxonomy、置信度、支持证据 ordinal、可能受影响的可靠性机制，以及“证据不足，暂不归因”的显式状态。不能因为一个 run 最终失败，就把其中所有 decision 都标成负样本。

### 7.2 延迟 Evaluation / Feedback

append-only 轨迹不修改历史 action，而是事后追加一条引用其 ordinal 的 evaluation。建议在后续 item schema 中扩展：

```ts
interface EvaluationAnnotation {
  evaluationId: string
  evaluatorId: string
  evaluatorVersion: string
  rubricHash: string
  targetOrdinals: number[]
  signalKind:
    | 'deterministic_check'
    | 'user_feedback'
    | 'process_reward'
    | 'task_outcome'
    | 'safety'
    | 'delayed_operational'
  verdict: string
  score?: number
  metrics?: Record<string, number>
  failureAttributions?: Array<{
    category: string
    targetMechanism: string
    confidence: number
    evidenceOrdinals: number[]
  }>
  critiqueRef?: string
  observedAt: number
  artifactHash?: string
  independentEvaluator: boolean
}
```

critique 原文可放在有权限的 artifact store，canonical item 只存可审计引用与 hash。

### 7.3 Artifact Registry

所有可进化对象必须是版本化产物：

- Task Contract Compiler / Evidence Planner / Verifier 规则；
- Task State schema、reducer、retention policy 与 Context Compiler；
- Progress / Drift / Recovery policy 与 Model Capability Profile；
- prompt / developer instruction / Skill / workflow；
- tool schema / tool implementation / router / budget policy；
- model / LoRA / PRM checkpoint；
- evaluator / guardrail / redaction policy；
- memory item 及其生效范围。

artifact registry 至少支持 base version、content hash、可取回内容、创建者、来源轨迹、审批状态、部署范围和 rollback target。仅有 hash 而无法取回内容不能满足 replay。

## 8. Reward 与评测契约

### 8.1 不使用单一总分

进化决策默认使用多目标向量：

```text
J(candidate) = {
  task_coverage,
  task_success,
  verified_correctness,
  repeat_pass_rate,
  lower_tail_success,
  cross_model_variance,
  false_success_rate,
  recovery_success_rate,
  goal_drift_rate,
  state_loss_rate,
  user_correction_rate,
  human_intervention_rate,
  regression_rate,
  safety_violations,
  cost_usd,
  latency,
  turns,
  tool_calls
}
```

候选比较优先使用硬约束 + Pareto frontier，而不是过早将安全、正确性、成本和速度压成一个可被 gaming 的标量。

其中 `false_success_rate` 是核心反指标：Agent 宣称完成，但独立验收不通过，通常比显式承认失败更危险。`lower_tail_success`、`cross_model_variance` 和 `repeat_pass_rate` 用于约束“平均分很好、但换模型、换扰动或重复执行就不稳定”的候选。

### 8.2 评测矩阵

每个可靠性机制候选至少在以下矩阵上与 incumbent 做配对比较：

```text
任务分布 × LLM / provider × 随机种子 × 环境扰动 × Agent 版本
```

- 任务分布同时报告总体结果、task family 结果和最差 cohort，不允许只报平均值；
- LLM 至少包含当前主模型与一个能力 / provider 不同的模型，用于识别机制是否过拟合模型特性；
- 环境扰动覆盖工具失败、延迟、权限拒绝、checkpoint 恢复、上下文压缩和外部状态变化；
- 同一候选必须重复运行，报告置信区间、方差、下尾成功率和不可重放样本占比；
- benchmark、阈值和切分在看到 candidate 结果前冻结。

### 8.3 信号层级

1. **确定性结果**：测试 / CI / 编译 / lint / gradmotion / graph gate，并且证据必须发生在最后相关 diff 之后。
2. **任务结果**：完成、驳回、重开、撤销、后续修复或长期无法完成。
3. **过程信号**：实际进展、重复尝试、错误恢复、工具参数错误、审批 deny / redirect。
4. **用户信号**：显式评分、纠正、重新提问、手工改写、接受 / 拒绝候选。
5. **延迟运维信号**：后续 CI、工件被回退、任务被重开、部署后故障、真实环境验收。
6. **LLM / PRM judge**：用于补充文本 critique 与过程估值，不能覆盖确定性失败。

### 8.4 状态不等于 reward

- `run_result.outcome=success` 只说明 Agent run 没有以内部错误终止，不自动证明用户任务正确完成；
- `parked` 只表示持久化挂起边界，不是正奖励也不是失败；
- exit code 0 只证明所选命令成功，不证明验证范围足够；
- 工具出错不必然是坏轨迹；若 Agent 快速识别并恢复，可能是有价值的过程样本。

### 8.5 自评分数不是 reward（硬性禁令）

> **禁止把 `TaskReview.assessment` 的四维评分（effectiveness / reliability / stability / efficiency）用作任何优化目标、reward 或晋升阈值。**

理由有二：

1. 它是**本系统自产的 LLM 自评**。用自己的评分训练自己，是自训练崩溃（policy collapse）的标准配方；近期工作已反复证明，用自监督代理信号完全替代可验证反馈，会在长期训练下出现严重失效。
2. TaskReview 的经验晋升门槛中，`candidateEligible`、`significance`、`abstractionLevel` 三项**全部由模型自述**，宿主唯一的客观校验只有"提案证据与 Finding 证据存在交集"。这些字段可以守住人工审核队列的信噪比，但不具备作为目标函数的抗 gaming 能力。

四维评分的正确用途：**人工审核时的排序与导航**，以及**失败模式聚类的特征**。

同理，`LearningProposal` 的 `impact` 三档等级也是模型自述，不得直接进入 §8.1 的多目标向量。真实 reward 只能来自 §8.3 第 1～5 层的信号；第 6 层 LLM / PRM judge 只做 tie-break 与过滤，且必须运行在独立上下文中——auto_verify 当前的隔离上下文设计需要保持。

未来若要给 `abstractionLevel` 这类自述字段提供客观校验，可行路径是跨任务聚类：统计同一 `findingId` 在多少条**独立 TaskCase** 中被重复推导出来，用复现次数把自述变成可对账的证据。

## 9. Evolution Control Plane

### 9.1 职责

控制平面是受治理的候选决策器，而不是一个能任意写生产代码的超级 Agent。它负责：

1. 按时间窗口、workspace、task family、mode 和健康状态选择合格 episode；
2. 聚类失败与成功模式，区分局部偶发失败和系统性问题；
3. 将问题路由到最小的可用干预面；
4. 调用对应 evolver 生成候选和变更解释；
5. 将候选放入不可变的 replay / held-out 评测；
6. 根据风险等级决定 no-op、reject、human review、shadow、canary 或 promotion；
7. 监测 canary delta，触发自动回滚；
8. 将候选、评测、审批、晋升和回滚全部回写为可审计事件。

### 9.2 路由原则

| 失败模式 | 首选干预 | 不应首先做的事 |
| --- | --- | --- |
| 任务边界含糊、遗漏验收项 | Task Contract Compiler | 执行后再凭感觉补标准 |
| Agent 宣称完成但独立验收失败 | Evidence Planner / Verifier | 只增加自我反思 token |
| 月级任务丢约束、丢 open loop | Task State Ledger / reducer | 把完整历史永久塞进 context |
| 长上下文噪音导致关键事实被淹没 | Context Compiler / retention policy | 无差别扩大上下文窗口 |
| 重复尝试、无新证据、偏离目标 | Progress / Drift / Recovery Controller | 继续按原计划消耗预算 |
| 同一机制跨模型表现剧烈波动 | Model Capability Adapter | 为单一模型固化全局策略 |
| 工具总是选错或参数构造失败 | tool description / schema / routing prompt | 把工具输出全量塞进 memory |
| 重复缺少局部事实 | state / memory 写入、修订与检索策略 | 更新模型权重 |
| 重复的程序步骤错误 | planning / workflow / Skill 候选 | 直接固化单条成功轨迹 |
| 验证正确但成本过高 | routing / budget / subagent / verification depth | 降低正确性硬门槛 |
| 问题跨 workspace、task、tool 和 harness 持续存在 | model / PRM / architecture candidate | 用单条轨迹触发权重训练 |

### 9.3 候选档案而非单线覆盖

候选应保留为一个多样性档案，而不是每轮用新版覆盖旧版。每个候选包含：

- candidateId、surface、base artifact version 和 patch；
- 来源 episode / trajectory ordinal；
- 诊断、预期改进和已知副作用；
- support / validation / held-out / canary 评测结果；
- 质量、成本、延迟和安全的 Pareto 位置；
- 生成模型、evolver 版本、审批者和发布范围；
- rollback target 和过期条件。

保留档案可以避免只围绕当前 benchmark 的单调爬山，也为不同 workspace / provider / task family 保留专用策略。

## 10. 部署与安全门槛

### 10.1 评测独立性

- evaluator 代码、rubric、held-out 数据与晋升阈值对 candidate agent 只读；
- replay 工作区和 candidate 分支无权写评测器；
- 度量由独立 runner 重新计算，不信任 Agent 报告的分数；
- 记录文件访问和 diff，检测 evaluator tampering 与 train/test leakage；
- 安全失败、数据越界、权限绕过为硬 veto，不能被成本或任务分数抵消。

### 10.2 风险分级

| 等级 | 示例 | 最高晋升权限 |
| --- | --- | --- |
| R0 | 只读诊断、统计、候选报告 | 自动运行 |
| R1 | shadow-only Task Contract 建议、workspace-local context / memory 排序、无副作用 prompt 候选 | 可自动 shadow / canary，必须自动回滚 |
| R2 | Task Contract 规则、Verifier、State / Context / Recovery policy、Skill、workflow、router | 默认人工批准后 canary |
| R3 | tool schema、新工具、Agent graph / 代码 | 人工 review + 强回归 + 有限灰度 |
| R4 | 权限、guardrail、evaluator、model weights | 独立治理和发布流程，不由执行 Agent 晋升 |

### 10.3 回滚是一等动作

每次 promotion 必须在发布前指定：

- incumbent artifact version；
- rollback target；
- canary 范围和最长观察时间；
- 正确性、安全、成本和延迟的回滚阈值；
- 正在运行的 session 是固定旧版还是允许在安全边界切换；
- 回滚后如何标记受影响轨迹与 candidate 失效。

## 11. 存储与索引决策

### 11.1 Canonical 不改用数据库

A3 的 `trajectory.jsonl` 继续是 append-only 真相源。自进化不应为了分析和训练方便而把 canonical 换成一个可就地修改的业务数据库。

### 11.2 学习数据是可重建投影

建议将学习面拆成：

```text
META_AGENT_HOME/
├── trajectories/                  # A3 canonical，不变
├── evolution/
│   ├── episodes/                 # 派生 episode，JSONL / Parquet
│   ├── artifacts/                # 版本化 prompt/skill/workflow/tool 引用
│   ├── candidates/               # 候选 patch 与 manifest
│   ├── evaluations/              # replay / held-out / canary 结果
│   └── control-plane.sqlite      # 可重建元数据和状态机，可选
└── index/                         # 现有 A3 投影
```

初期仍可用 JSON / JSONL + atomic write。当需要跨数千条 episode 聚合、多维筛选、候选状态机和实验对比时，引入 SQLite / DuckDB 作为**可重建的查询与实验投影**。数据库不替代 canonical trajectory，也不成为证据唯一来源。

### 11.3 Task State 与 Context 决策存在哪里

- **状态变化事件**写入 A3 canonical trajectory，例如 goal / constraint / decision / assumption / artifact / evidence / open loop 的新增、确认、失效与冲突；
- **当前 Task State**由 reducer 从事件重建，可在 `state_checkpoint` 或独立 projection 中缓存，以加快 auto-scheduler 的 park / wake；缓存损坏时必须能从 canonical 恢复；
- **Context Compiler 决策**记录所选 state / memory 的引用、未选择原因、token 预算、compiler version 和生成的 context hash；不必重复保存所有原文；
- **跨任务 Memory**继续作为独立、版本化、带 scope / TTL 的产物，不能与当前任务真值混在一起；
- SQLite / DuckDB 只承担检索、聚合和实验状态机。第一阶段不因引入 Task State 而增加一个新的不可替代数据库真相源。

## 12. 首批落地实验

### 12.1 实验 A：Task Contract Compiler

**假设**：在执行前生成、校验并冻结任务契约，再让独立 Verifier 按 claim 所需证据验收，可以降低遗漏验收项、返工和假成功，并且不把 Agent 绑定到某个 LLM。

**数据与分组**：

1. 从已有已闭合轨迹中选取同时具备原始请求、最终产物、确定性验证和用户 / 人工结论的任务；证据不足的轨迹只进入 support，不进入 held-out 结论集。
2. 新增一批前瞻任务，在 Agent 执行前以 shadow 方式生成 Task Contract，并由人工标注 `完整 / 缺项 / 不可验证 / 过度约束 / 错解意图`。
3. 按 task family、时间和 workspace 去重后切分 support、validation、held-out；同源任务及其改写不得跨切分泄漏。
4. 在至少两个不同 LLM / provider、多个随机种子和相同工具环境下，配对比较 incumbent 与 candidate。

**实验变体**：

- A0：当前执行与完成判断方式；
- A1：固定规则版 Task Contract Compiler + Evidence Planner；
- A2：由标注轨迹提出的 candidate compiler / verifier policy，但 evaluator、held-out 和晋升阈值保持不可变。

**执行协议**：

1. 编译 `goal / non-goals / constraints / acceptance claims / evidence obligations / ambiguity / escalation conditions`；
2. 在首个有副作用动作前冻结 contract hash；执行器不得自行降低标准；
3. 如需变更，只能追加带原因和来源的 amendment；放宽验收必须由用户或独立控制面批准；
4. Verifier 逐 claim 检查证据，输出 `pass / fail / insufficient_evidence / contract_defect`；
5. 保存 contract、amendment、evidence、verdict 与实际结果之间的引用关系，供反事实分析。

**核心指标**：contract 缺项率、不可验证 claim 率、过度约束率、验收证据覆盖率、verified task success、false success、用户纠正 / 重开率、返工轮数、成本和延迟。

**进入下一阶段的条件**：candidate 在 held-out 上显著降低 false success 和用户返工；verified correctness、安全和最差 task / model cohort 不退化；额外成本处于预先冻结的预算内；收益不能只来自更频繁地拒绝任务或把任务标成需要人工处理。

### 12.2 实验 B：Long-horizon State / Context Compiler

**假设**：将“发生过什么”的 trajectory、“当前仍成立什么”的 Task State 与“本轮模型必须看到什么”的 context 分离，可以让月级任务经历 park / wake、压缩、模型切换和环境变化后仍保持目标、约束和 open loop，同时减少历史噪音。

**实验对象**：优先选择多次 auto-scheduler wake、多个 checkpoint、跨天运行或已发生 compaction 的任务；另外构造包含工具失败、权限拒绝、外部工件变化、延迟恢复和模型切换的可控长周期场景。

**实验变体**：

- B0：当前 checkpoint / compaction / context 行为；
- B1：结构化 Task State Ledger，但仍使用固定 context 选择规则；
- B2：Task State Ledger + candidate Context Compiler + wake validation；
- B3：对 B2 做字段消融或注入陈旧 / 冲突信息，用于估计不同 state item 的真实边际价值和抗噪能力。

**执行协议**：

1. 在关键决策、工件变更、验证结果、blocker、park 和 wake 时生成 append-only state event，并由 reducer 计算当前 Task State；
2. 每次 wake 都将 state 声明与 workspace、artifact version、checkpoint 和最新 evidence 重新核对；
3. Context Compiler 记录每个注入项的来源、选择原因和 token 成本，也记录未选择但可召回的候选项；
4. 在固定里程碑执行 restart / compaction / delayed wake / model switch，比较恢复后的首个计划和最终结果；
5. 用反事实消融判断：移除某类 state 是否导致失败，加入某类信息是否只增加噪音；不可重放动作不伪造反事实结果。

**核心指标**：目标 / 约束丢失率、open loop 遗漏率、goal drift、陈旧状态采纳率、重复探索 / 重复工具调用、wake 后恢复轮数、verified task success、false success、context token、成本和延迟。

**进入下一阶段的条件**：B2 在 held-out 长周期任务上降低 state loss、goal drift 和重复探索；任务正确性与安全不退化；压缩后恢复优于 B0 / B1；Context Compiler 的收益在不同模型上成立，而不是仅对某个长上下文模型有效。

### 12.3 两个实验的共同边界

- 不更新模型权重；
- 不自动修改 evaluator 或权限策略；
- 不跨 workspace 共享经验；
- 不允许 candidate 修改自身的晋升脚本与测试数据；
- 不在没有可回放证据的 robotics 真实硬件动作上做自动反事实试验。

## 13. 阶段验收标准

### 13.1 E0｜证据就绪

- A3-M5 真实发布周期 parity 证据通过；
- canonical / projection 无持续 degraded；
- 生产评测层能发射可版本化 evaluation；
- 支持事后引用既有 ordinal 附加延迟 feedback；
- Task Contract、evidence obligation、Task State 和 context selection 都有稳定的版本与来源引用；
- 定义 failure taxonomy、training eligibility、replay class、artifact version 和数据切分契约；
- 冻结首版“任务 × 模型 × 随机种子 × 环境扰动”评测矩阵和 false success 计算口径；
- 用现有轨迹 fixture 证明 Episode Builder 幂等、可重建且不修改 canonical。

### 13.2 E1｜Shadow Mechanism Learner

- 能从轨迹自动产生失败簇、成功模式和可引用诊断；
- 每个诊断引用具体 trajectory / ordinal，不凭空归因；
- 诊断能落到 Task Contract、Verifier、State、Context、Recovery、Model Adapter 等具体机制，证据不足时输出 unknown；
- 能生成机制候选与预期因果链，但不直接修改生产机制或外置产物；
- 数据越界、证据不足或 evaluator 不独立时 fail closed；
- 只产生报告和候选，对生产行为零影响；
- 候选、评测和拒绝决策均可审计。

### 13.3 E2｜可靠性机制进化

- incumbent / candidate 在相同不可变 replay cohort 上配对比较；
- support / validation / held-out 无泄漏；
- Task Contract Compiler 和 Long-horizon State / Context Compiler 两个首批实验均达到第 12 节预注册门槛；
- 在至少两个 LLM / provider 上报告重复运行、下尾成功率、跨模型方差和最差 cohort；
- false success 不得退化；任务成功提升不能靠扩大拒绝、park 或人工介入来伪造；
- 候选不降低确定性验证和安全硬指标；
- 统计显著性或最小样本量门槛预先固化，不在看到结果后改阈值；
- 人工能审阅 candidate diff、来源证据、评测结果和 rollback target；
- canary 可一键或自动回滚，旧 artifact 不被覆盖。

### 13.4 E3｜受控自动晋升

- 自动晋升只对明确 allowlist 内的 R1 产物开放；
- 每个 canary 有最大时间、最大轨迹数和最大成本；
- 出现安全失败、回归、成本越界或 telemetry 失明时自动回滚；
- candidate agent 无法修改或绕过自身观察和回滚机制；
- 定期使用旧任务与分布漂移任务验证持续改进而非局部过拟合。

## 14. 主要风险与对策

| 风险 | 表现 | 对策 |
| --- | --- | --- |
| Reward hacking | 改 evaluator、报假分、利用隐藏数据 | evaluator 锁定、独立重算、文件访问审计、泄漏检测 |
| Contract gaming | 把标准写得过低、过窄或不可证伪，从而更容易宣称成功 | contract 独立审查、冻结后再执行、缺项 / 过约束标签、放宽需审批 |
| False success | Agent 运行正常并宣称完成，但用户目标或关键 claim 未满足 | claim-evidence 映射、独立 Verifier、延迟结果回流、作为核心硬指标 |
| Context collapse | 每次反思都重写上下文，细节逐渐消失 | 增量 playbook、版本化条目、证据引用、不在原位无限摘要 |
| State staleness / noise | 旧决定被当成当前事实，或低价值历史淹没关键状态 | provenance、validity、wake validation、冲突检测、反事实消融 |
| Memory pollution | 错误或过期经验反复被召回 | confidence、provenance、scope、TTL、冲突检测和召回效果评估 |
| Catastrophic regression | 新策略只优化新任务，旧能力下降 | 历史 held-out、不可变回归集、版本固定、自动回滚 |
| Model-specific overfitting | 机制只适合生成它的模型，换模型后波动加大 | 多模型评测矩阵、capability profile、最差 cohort 门槛、按模型路由 |
| Feedback loop bias | 已部署策略只产生自己擅长的数据 | 保留 incumbent 对照、时间切分、对抗 / frontier 任务、外部基准 |
| Privacy / tenant leakage | 共享 Skill 携带项目私有细节 | eligibility、workspace isolation、内容审查、只共享抽象策略 |
| Replay illusion | 在伪回放环境中有效，真实环境无效 | replay class、真实 canary、不可回放事件排除、延迟运维信号 |
| Unbounded self-modification | Agent 修改自己的评测、权限或发布面 | 候选分支、权限分离、审批、不可变信任根 |

## 15. 建议的实施顺序

1. 先完成当前 A3-M5 发布周期观察，不将自进化与切读绑为一次发布。
2. ~~补 production `evaluation` 发射~~（0.9.3 已完成）；继续补**延迟 feedback API**，先接确定性测试 / CI / graph / robotics 验收信号。
3. **建离线回放评测集**（缺口 H）与**经验注入 provenance**（缺口 G）。这两项优先于选择任何优化算法——前者提供 fitness function，后者提供归因前提。
4. 冻结可靠性指标、failure taxonomy、Task Contract / Evidence / Task State 数据契约和跨模型评测矩阵。
5. 先做 **L0 参数与阈值**的统计调优（verify 轮数、compaction 触发点、重试退避），它同时是数据质量的试金石；再实现 Episode Builder 其余粒度、artifact registry 和 training eligibility，所有投影可从 canonical 重建。
6. 实现只读 Shadow Mechanism Learner，用真实轨迹验证它能否稳定完成失败归因，不允许改生产机制。（Reviewer 模式已提供其证据读取与 Finding 归因的基础。）
7. 先做 Task Contract Compiler 实验，建立“先定义通过、再执行、独立验证”的最小闭环。
8. 再做 Long-horizon State / Context Compiler 实验，验证 park / wake、compaction、模型切换和月级任务恢复。
9. 两个 P0 实验稳定后，扩展 Progress / Drift / Recovery Controller 与 Model Capability Adapter；随后才考虑 planning、tool grounding、Skill / Memory / prompt 产物候选。
10. 只有当缺陷在 Task Contract、State、Context、Verifier、Recovery、Tool、Skill 等机制层都无法解决，并且跨 task / workspace / model 持续存在，才评估架构或模型权重进化——并且必须先接受"这需要引入 open-weight 底座"这一前提。

第 3 步与第 5 步对应[算法选型文档](../知识系统/轨迹数据利用与进化算法选型.md) §7 的阶段 1～2；第 7～9 步的机制候选属于该文的 L1（上下文 / playbook）与 L2（workflow 归纳），其优化器选择（GEPA 式反射演化 / ACE 式增量 playbook）以该文为准。

## 16. 待冻结的关键决策

开始 E0 实现前，需要将以下事项从讨论结论冻结为契约：

1. **好 Agent 的发布判据**：各 mode / task family 的硬证据、软证据、延迟证据，以及稳定性、下尾成功率和 false success 门槛；
2. **Task Contract 的权责**：谁生成、谁确认、何时冻结、谁有权 amendment，尤其是谁可以放宽验收标准；
3. **Task State 的真值规则**：哪些字段必须持久化，谁负责 reducer，冲突、失效、外部漂移和 wake validation 如何处理；
4. **Context Compiler 的可见面**：它能读取哪些 state / trajectory / memory，如何记录选择与遗漏，token 预算和 fail-closed 条件是什么；
5. **评测信任根放在哪里**：evaluator、held-out 集、晋升阈值和 rollback controller 的代码与权限归属；
6. **哪些面允许自动更新**：默认只开放 R1 allowlist；Task Contract、Verifier、State、Context 和 Recovery policy 在稳定前均按 R2 人工批准；
7. **数据资格默认值**：轨迹是否默认只能 local-only，何时允许 workspace 内聚合或跨 workspace 抽象共享；
8. **首批实验基准集与模型矩阵**：选哪些已有 auto / coding / long-horizon 任务，使用哪些 LLM / provider 作为 support、validation、held-out 和 canary。

## 17. 参考资料

- Ran Yan et al., [Next-Generation Agentic Reinforcement Learning Systems Enable Self-Evolving Agents](https://arxiv.org/abs/2607.01120), 2026.
- Huan-ang Gao et al., [A Survey of Self-Evolving Agents](https://arxiv.org/abs/2507.21046), 2025.
- Huichi Zhou et al., [Memento-Skills: Let Agents Design Agents](https://arxiv.org/abs/2603.18743), 2026.
- Ziyu Ma et al., [SkillClaw: Let Skills Evolve Collectively with Agentic Evolver](https://arxiv.org/abs/2604.08377), 2026.
- Qizheng Zhang et al., [Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models](https://arxiv.org/abs/2510.04618), 2025.
- Lakshya A. Agrawal et al., [GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning](https://arxiv.org/abs/2507.19457), 2025.
- Shengran Hu et al., [Automated Design of Agentic Systems](https://arxiv.org/abs/2408.08435), 2024.
- Jenny Zhang et al., [Darwin Gödel Machine: Open-Ended Evolution of Self-Improving Agents](https://arxiv.org/abs/2505.22954), 2025.
- Yinjie Wang et al., [OpenClaw-RL: Train Any Agent Simply by Talking](https://arxiv.org/abs/2603.10165), 2026.
- Peng Xia et al., [MetaClaw: Just Talk -- An Agent That Meta-Learns and Evolves in the Wild](https://arxiv.org/abs/2603.17187), 2026.
- Zhiheng Xi et al., [AgentPRM: Process Reward Models for LLM Agents via Step-Wise Promise and Progress](https://arxiv.org/abs/2511.08325), 2025.
- Yueqi Song et al., [Agent Data Protocol: Unifying Datasets for Diverse, Effective Fine-tuning of LLM Agents](https://arxiv.org/abs/2510.24702), 2025.
- Junhao Zheng et al., [LifelongAgentBench: Evaluating LLM Agents as Lifelong Learners](https://arxiv.org/abs/2505.11942), 2025.
- Yuyao Wang et al., [EvoMemBench: Benchmarking Agent Memory from a Self-Evolving Perspective](https://arxiv.org/abs/2605.18421), 2026.
- Yonas Atinafu and Robin Cohen, [RewardHackingAgents: Benchmarking Evaluation Integrity for LLM ML-Engineering Agents](https://arxiv.org/abs/2603.11337), 2026.
- [AReaL 2.0 repository and online RL documentation](https://github.com/areal-project/AReaL), 2026.
