# meta-agent 自进化方案审查

> 日期：2026-08-25
>
> 审查对象：[`meta-agent 自进化方案`](./meta-agent-自进化方案.md)、[轨迹数据利用与进化算法选型](../知识系统/轨迹数据利用与进化算法选型.md)、[自进化实施计划](../知识系统/自进化实施计划.md)、[轨迹学习 Reviewer 模式设计](../知识系统/轨迹学习Reviewer模式设计.md)
>
> 代码基线：`0.9.3`
>
> 决策：**方向通过；仅批准 E0 测量与信任底座建设。行为级进化、自动晋升、bandit 与权重训练当前 No-Go。**

## 0. 审查结论

当前方案最有价值的判断是：meta-agent 不应让生产 Agent 直接改写自己，而应从可审计轨迹中提出版本化候选，经独立评测、灰度和回滚后影响未来行为；优化对象也应优先放在 Task Contract、Verifier、State、Context 和 Recovery 等可靠性机制，而不是把“生成更多 Memory / Skill”误当成进化。

这个方向可以保留。但三份方案文档目前还不能作为行为级自进化的开工依据，原因不是缺少演化算法，而是**测量、隔离、因果归因和路线顺序尚未闭合**：

- 治理文档把 Task Contract / Verifier / State / Context / Recovery 定为 P0，实施计划却先做 ExperienceCandidate 注入与 playbook，P0 机制没有成为独立里程碑；
- 同一份 `held_out` 被用于反复 A/B、候选选择和晋升，长期必然退化为 validation；
- 当前 TaskCase 能提供证据边界，但不能恢复任务开始前的可执行环境，也不是“因果单元”；
- provenance 只能说明“注入了什么”，不能单独证明“哪条经验带来了收益”；
- EvalSet 草案允许执行 `setupCommands` 和 `check.command`，但没有冻结 evaluator bundle、凭据、网络、文件系统和副作用边界；
- 真实轨迹在进入评测集前还没有 `trainingEligibility` / workspace 授权闸门；
- IPS / doubly robust 需要 logging policy、动作概率和支持覆盖，当前历史路由日志不具备这些前提。

因此本次审查的发布判定是：

| 范围 | 判定 | 允许的工作 |
| --- | --- | --- |
| E0 测量与信任底座 | **Go** | 数据资格、实验清单、不可变 evaluator、隔离 runner、合成 fixture、provenance 记录 |
| E1 只读 Shadow 分析 | **Conditional Go** | 仅在数据资格和证据等级明确后做统计、失败聚类与候选报告；不得改变生产行为 |
| E2 可靠性机制候选 | **No-Go** | 等 Task Contract / Verifier 与 State / Context / Recovery 两组 P0 实验契约冻结后再审 |
| E3 自动晋升 | **No-Go** | 等独立测试、canary、暴露追踪和自动回滚实证通过后再审 |
| L3 bandit / L4 权重训练 | **No-Go** | 当前没有可识别的 logging policy / propensity，也没有权重训练底座 |

## 1. 审查范围与证据

本次审查核对了四份设计文档与以下现有实现：

- A3 trajectory schema、append-only recorder、索引与隐私过滤；
- `TaskCase`、`TaskReview`、`LearningProposal`、`ExperienceCandidate` 与人工批准闸门；
- auto Verify 的 `evaluation` 发射链路与隔离 Judge；
- robotics `ExperienceWorkingSet` 的候选选择与 `injectedIds` 运行时痕迹；
- 当前 CLI、schema 和测试中是否已经存在 EvalSet、注入 provenance、数据资格和实验注册表。

代码核对结论：

| 能力 | 当前状态 | 审查判断 |
| --- | --- | --- |
| append-only canonical、ordinal、root / parent、schema fixture | 已实现 | 可作为审计真相源 |
| auto Verify 发射 `evaluation` | 已实现 | 是上下文隔离的 LLM 过程信号，不是确定性 reward |
| TaskCase / TaskReview / Reviewer 只读证据工具 | 已实现 | 可作证据边界和弱标注输入 |
| LearningProposal → 人工批准 → ExperienceCandidate | 已实现 | 人工闸门成立，但 Candidate 尚无受控运行时注入通道 |
| EvalSet / EvalRunner / `evalset` CLI | 未实现 | 仍是设计草案 |
| `knowledge.action=injected` 与内容版本 | 未实现 | 只有运行时 `injectedIds`，没有 canonical provenance |
| `trainingEligibility` 与数据隔离策略 | 未实现 | 阻断真实轨迹进入学习 / 评测投影 |
| artifact / evaluator / experiment registry | 未实现 | 阻断可重复候选比较与可信回滚 |

针对 reviewer、trajectory、Verify 和 Kernel 轨迹链路运行了定向测试：**9 个测试文件、116 个用例全部通过**。这证明现有审计与 Reviewer 底座具备工程完整性，但不等于评测与进化闭环已经成立。

## 2. 做对了什么

### 2.1 北极星与边界正确

方案把“自进化”定义为受治理的候选生成、评测、灰度、晋升和回滚，而不是生产 Agent 原地改代码。这是正确的系统边界，也与轨迹协议、数据代理和 evolution control plane 的系统分层一致。

### 2.2 把 false success 放在核心位置

`run_result=success`、exit code 0 和 LLM 自称完成都不能自动证明用户目标达成。方案明确区分运行终止状态、证据和任务正确性，并把 false success 设为硬反指标，这一点应保留。

### 2.3 不把自产评分当 reward

禁止使用 `TaskReview.assessment` 四维自评分训练或晋升，是当前文档中最重要的硬约束之一。TaskReview 适合做人工导航、弱标签和失败聚类输入，不适合作为信任根。

### 2.4 append-only 与 rollback-first 的治理方向正确

canonical trajectory 不被可变数据库替代，候选产物版本化，晋升前指定 rollback target，且 evaluator / held-out / guardrail 不允许被候选修改。这些是后续控制面的必要基础。

### 2.5 权重训练被正确后置

当前 runtime 是 API 客户端，不控制主模型 checkpoint、token logprob 或 rollout 基础设施。优先 L0～L3、把权重训练限制在未来的窄任务与独立底座，是合理判断。

## 3. 阻断项

### P0-1｜治理优先级与实施顺序冲突

治理主文档把 Task Contract / Evidence Verifier / Task State / Context Compiler / Progress & Recovery 定为 P0，并在首批实验中明确要求先做 Task Contract，再做 long-horizon State / Context。实施计划却在阶段 3 先注入 ExperienceCandidate，阶段 4 转入 playbook / prompt / workflow，两个 P0 实验没有成为阶段里程碑。

这不是文案差异，而是优化目标漂移：团队会先建“经验进入 prompt”的闭环，再补“什么算完成、什么状态仍为真、证据是否充分”的信任底座。这样最容易把未经验证的 Reviewer 产物扩散到后续轨迹，并让后续数据受到策略污染。

**必须修正**：阶段 1～2 完成后，先执行 Task Contract + Verifier，再执行 State + Context + Recovery。Experience / playbook / workflow 只能在失败簇证明它是合适干预面之后进入运行时。

### P0-2｜`held_out` 被反复使用，测试集会失去独立性

实施计划要求阶段 2 参数调整、阶段 3 A/B、阶段 4 prompt 演化和最终晋升都在 `held_out` 上看结果。只要人或 evolver 根据这些结果继续提候选，这个集合就已经参与优化，不再是 held-out。定期“换血”不能消除已经发生的适应性泄漏。

**必须修正**：至少分成四层：

```text
support / train     生成诊断、经验和候选
validation / dev    调参、筛选、Pareto 档案
sealed test         独立 runner 在候选冻结后只执行一次发布判定
canary              真实流量的延迟结果与回滚判定
```

sealed test 的内容、细粒度结果和 evaluator 实现不向 candidate generator 暴露。若需要多轮适应性查询，要明确查询预算和重置策略；不能继续把它称作普通 held-out。

### P0-3｜EvalCase 不能恢复“任务开始前”的可执行环境

当前草案只记录 `prompt + repo + commit + setupCommands`。但现有 `TaskCase` 的 `inputHash` 是对**完整任务结束后的所有轨迹行**做 hash，不是初始输入 hash；索引中的 `firstPrompt` 只保留前 240 字；trajectory schema 虽有 `gitBase`，当前 Kernel 打开轨迹时没有稳定填入它。更重要的是，任务完成后的 commit / working tree 不能作为重跑起点，否则用例可能在已有答案的状态上直接通过。

**必须修正**：EvalCase 必须引用任务开始前的不可变 `baseSnapshotRef`，并记录 submodule / LFS、未跟踪 fixture、依赖锁、环境变量白名单、时间 / 网络模拟、初始化与清理配方。无法恢复初始状态的历史 TaskCase 只能进入 support 分析，不能进入 sealed test。

同时应把第一版称为 **controlled re-execution**，不要称作 deterministic replay。`replayClass` 只描述动作可重放性，不能替代环境复现等级。

### P0-4｜evaluator 的执行隔离尚未成为可执行契约

EvalCase 草案中的 `setupCommands`、`check.command`、`file_exists` 和 `file_matches` 都直接携带可执行或可读取内容，但没有定义：

- 命令由谁签名、是否允许 shell、超时、输出上限和进程树回收；
- 路径是否必须相对 sandbox、如何防 `..`、绝对路径和 symlink escape；
- evaluator 是否与 candidate 使用不同的只读挂载、凭据和网络策略；
- candidate 是否能通过修改测试脚本、PATH、依赖或生成同名文件骗过检查；
- setup / execute / verify / teardown 各阶段的副作用如何隔离和审计。

**必须修正**：EvalCase 不应直接把任意命令当作信任根，而应引用独立版本化的 `evaluatorBundleRef`。runner 在一次性 workspace / 容器中分阶段执行，candidate 无权写 evaluator bundle，验证进程使用独立最小权限身份，所有路径、网络、凭据、超时与资源上限 fail closed。

### P0-5｜真实轨迹进入评测集之前缺少数据资格闸门

当前隐私过滤解决 secret、thinking 和大字段问题，但“可审计”不等于“可用于学习或重复执行”。实施计划把 `trainingEligibility` 放在后续建设，却计划先从真实 TaskReview 回捞 EvalSet。

**必须修正**：数据资格必须前移到阶段 0，默认值采用 `denied` 或 `local_only`。任何 TaskCase 进入 support / validation / sealed test 前都要有 workspace、数据主体、保留期限、允许用途和跨 workspace 边界；缺失资格时 fail closed。评测集导出物仍需二次脱敏，且不得携带生产凭据。

### P0-6｜TaskCase 与 provenance 被赋予了不存在的因果含义

TaskCase 把 root + child + 多 run 聚成稳定证据范围，这使它成为很好的**评测单元**，但它没有 treatment assignment、对照组和反事实，不能称为因果单元。类似地，记录 `injectedIds` 只能证明暴露关系；若多条经验一起注入、选择器按任务难度选择、或条目来自同源任务，仅凭 provenance 不能回答“哪条经验有贡献”。

**必须修正**：

- 文档统一把 TaskCase 改称“任务级证据边界 / 评测单元”；
- 阶段 3 的条目边际价值必须通过预注册的随机开关、配对消融、factorial 设计或 switchback 实验估计；
- 记录 eligible set、实际选择、顺序、slot、selector version、分配概率与目标 turn；
- Candidate 的来源 TaskCase、同源改写和后代轨迹不得跨 support / validation / sealed test；
- provenance 允许“可归因分析”，不允许单独支持因果宣称。

## 4. 高优先级缺口

### P1-1｜auto Verify 是隔离 LLM judge，不是确定性 evaluator

现有 Verify Judge 确实不看执行 Agent 的推理叙述，并优先在临时快照中只读取证；但其 rubric 明确不运行 typecheck / test / lint，最终仍是 LLM 判断，而且通常与 executor 共用 provider 和运行时管理面。它满足“上下文隔离”，尚不满足完整的“治理独立”。

建议给 evaluator 明确分级：

| 等级 | 含义 | 可用作 |
| --- | --- | --- |
| T0 | executor 自报 | 仅展示 |
| T1 | 隔离上下文 LLM judge | critique、过程弱信号、人工导航 |
| T2 | 独立进程的确定性检查 | 主要自动指标 |
| T3 | 独立身份 / 权限 / artifact 的外部 CI 或人工验收 | 晋升信任根、延迟结果 |

现有 `auto_verify` 应标为 T1，不能因为 item 类型叫 `evaluation` 就升级为 reward。

### P1-2｜Artifact Registry 与 Experiment Manifest 被放得太晚

在比较 incumbent 与 candidate 之前，必须能还原完整的候选面：prompt、Skill、tool schema、runtime、model/provider、selector、evaluator、数据切分和 workspace snapshot。只有 hash、不能取回内容，或只记录“当前配置”，都不能复现结果。

**修正要求**：阶段 1 就交付最小 Artifact Registry 与 `ExperimentRunManifest`，而不是阶段 2 以后再补。任何评测结果缺少完整 manifest 时只能用于调试，不能进入晋升报告。

### P1-3｜20～50 个用例只够验证评测管线，不够支撑多维晋升结论

20～50 个高质量用例适合验证 schema、runner、false success 口径和初步方向，但在多个 task family、两个 provider、多个 seed、环境扰动和多候选比较下，很难同时估计最差 cohort、重复通过率和小幅提升。

**修正要求**：

- 把 20～50 个定义为 pilot，不把“有统计可辨差异”写成固定承诺；
- 预注册最小有意义效应、置信区间、重复次数和停止规则；
- TaskCase 是统计单元，重复 seed 不能当作新增独立样本；
- 使用分层 / 配对分析，并控制多候选、多指标的重复比较；
- 无足够 power 时输出 inconclusive，不把“不显著”等同于等价。

### P1-4｜部分指标方向会诱导错误行为

`human_intervention_rate ↓` 会把必要澄清、高风险升级和正确拒绝一并惩罚；`recovery_rate` 若不限制分母，会奖励 Agent 先制造更多工具错误再恢复；`false_success_rate` 也没有明确是“错误完成数 / 宣称完成数”还是“错误完成数 / 全部任务数”。

**修正要求**：拆分 preventable correction、required escalation、user clarification 和 safety denial；恢复率只统计预先定义的 eligible incident；同时报告 false-success precision 风格分母与 per-case 风险；安全违规为硬 veto，不能只存在于治理文字而缺席指标契约。

### P1-5｜风险等级不能只按 artifact 名称判断

当前 R1 把 workspace-local context / memory 排序和“无副作用 prompt”列为可自动 canary。但 prompt 或注入内容一旦进入拥有写工具、网络或审批能力的 Agent，就可能改变真实副作用；它并不因为自身是文本而天然低风险。

**修正要求**：风险按“候选影响的有效能力 × 数据范围 × 可逆性 × blast radius”计算。进入有副作用 executor 的 prompt / context 默认至少 R2；R1 只允许 shadow、只读 worker 或在无外部副作用 sandbox 中执行的候选。

### P1-6｜历史日志不能直接支持 IPS / doubly robust

实施计划提出用历史轨迹做 IPS / doubly robust，但当前路由通常是确定性选择，轨迹没有 logging policy version、eligible actions、action probability，也无法证明不同 action 在同类 context 上有支持覆盖。此时 IPS 权重不可计算，缺支持时即使拟合 reward model 也会产生不可验证外推。

**修正要求**：bandit 前先设计受约束的随机 logging policy，只在安全可行域内探索，记录 eligible set、选择概率和拒绝原因；覆盖不足时限制目标策略，不允许把普通历史日志包装成无偏反事实评估。

### P1-7｜延迟反馈还缺幂等与时序契约

事后 CI、回退、任务重开可能重复到达、乱序到达或互相矛盾。当前建议 schema 有 `evaluationId` 和 `observedAt`，但还需要明确 source event id、幂等键、target artifact / diff、supersedes / contradiction 关系和最大等待窗。

**修正要求**：延迟反馈 append-only；重复事件幂等；新判断不覆盖旧判断；晋升报告按预注册观察窗重算，并区分“尚未观察”与“观察后通过”。

## 5. 修订后的实施顺序

当前六阶段计划应重排为以下七个 gate。序号表示依赖关系，不表示固定工期。

```text
G0  信任与数据契约
    eligibility / evaluator trust / artifact registry / experiment manifest
                     │
                     ▼
G1  受控重执行评测底座
    初始快照 / 隔离 runner / support-dev-sealed-test / 指标与统计契约
                     │
                     ▼
G2  只读 Shadow + L0
    数据质量审计 / 描述统计 / failure taxonomy / 参数候选（不直接改默认值）
                     │
                     ▼
G3  Task Contract + Verifier
                     │
                     ▼
G4  State + Context + Recovery
                     │
                     ▼
G5  Experience / playbook / workflow
    仅处理失败簇证明适合由外置知识解决的问题
                     │
                     ▼
G6  Routing bandit
    先有随机 logging policy、propensity 与支持覆盖，再做 OPE / canary
                     │
                     ▼
G7  窄任务权重训练（可选，重新立项）
```

三个变化必须明确：

1. provenance 与评测集不再是唯二阶段 1 任务；数据资格、evaluator bundle、artifact registry 和 experiment manifest 同样是硬依赖。
2. P0 可靠性机制实验前移到 Experience 注入之前。
3. “完成至少 3 个参数调整”“失败簇覆盖 70%”这类产出配额不再是成功标准。能够证据充分地得出“当前不应改参数”同样是成功；覆盖率不能驱动强行归类。

## 6. 必须补齐的数据契约

### 6.1 EvalCase

除现有草案外，至少增加：

```ts
interface EvalCaseRequiredRefs {
  eligibilityRef: string
  baseSnapshotRef: string
  environmentManifestRef: string
  evaluatorBundleRef: string
  resetRecipeRef: string
  taskContractRef: string
  criteriaOrigin: 'user' | 'external_spec' | 'human_curated' | 'reviewer_generated'
  contaminationGroupId: string
  riskTier: string
}
```

从 TaskReview 回捞的 success criteria 是 Reviewer 看过执行结果后的回顾性产物，存在 post-treatment bias。它只能作为人工定稿的候选，不能原样成为 sealed evaluator。`criteriaOrigin=reviewer_generated` 不得进入 sealed test，除非经过独立人工 / 外部规范重写并生成新版本。

### 6.2 ExperimentRunManifest

每次比较至少冻结：

- case / split / snapshot / evaluator bundle 版本；
- incumbent 与 candidate 的完整 artifact set；
- model、provider、sampling、tool schema、runtime 与权限策略；
- assignment arm、随机种子；若是策略选择，还要记录 eligible actions 与 propensity；
- setup / execute / verify / teardown 的时间、资源和网络边界；
- runner version、环境指纹、暴露轨迹和结果证据；
- 预注册的指标、最小效应、停止规则与 rollback threshold。

### 6.3 Injection provenance

`recalled`、`eligible`、`selected`、`rendered`、`injected` 必须分开。真正进入模型上下文时记录：

- entry id、content hash、版本链与来源 TaskCase；
- selector version、query hash、eligible set、选择概率与排除原因码；
- 注入顺序、slot、目标 run / turn、token 数和最终 context hash；
- 实验 arm 与候选 artifact version。

未选候选只记录 id / hash / reason code，不复制正文；自由文本 `reason` 仍需脱敏和长度限制。

## 7. 放行门槛

### 7.1 真实 TaskCase 进入 EvalSet 前

- [ ] `trainingEligibility` / workspace 授权存在且默认 fail closed；
- [ ] 能恢复任务开始前的 base snapshot，而不是任务完成后的状态；
- [ ] evaluator bundle 不可被 candidate 写入；
- [ ] runner 的文件、进程、网络、凭据和资源边界有失败路径测试；
- [ ] support / validation / sealed test 按 lineage 与 contamination group 隔离；
- [ ] 用纯合成 fixture 完成一次端到端重执行、清理和结果复算。

### 7.2 任何 Experience / prompt 候选进入 Agent 上下文前

- [ ] provenance 能对账到最终 context hash；
- [ ] 候选来源与评测切分无泄漏；
- [ ] 注入默认关闭，可按 workspace / task / session 一键关闭；
- [ ] 先完成 shadow 与预注册配对实验；
- [ ] 进入有副作用 executor 时按 R2 处理；
- [ ] rollback 能定位所有暴露 session 与受影响轨迹。

### 7.3 任何候选晋升前

- [ ] candidate 已冻结，之后才由独立 runner 打开 sealed test；
- [ ] false success、安全、最差 cohort 与必要升级率不退化；
- [ ] 提升大于预注册的最小有意义效应，或明确记录 inconclusive；
- [ ] canary 有最大时间、轨迹数、成本、blast radius 和自动回滚；
- [ ] 延迟反馈观察窗结束，或风险所有者书面接受尚未观察部分；
- [ ] evaluator、阈值、数据和 rollback controller 对 candidate 只读且有访问审计。

## 8. 文档级修改要求

下一版方案应同时修改以下表述，避免读者继续得到过强结论：

1. `TaskCase 是任务级因果单元` → `TaskCase 是任务级证据边界与评测单元`；
2. `数据层基本就绪` → `审计与弱标注读取底座就绪；可重复评测、数据资格和实验归因未就绪`；
3. `provenance 能回答哪条经验有贡献` → `provenance 是归因必要条件，因果结论还需要受控分配或消融`；
4. `held_out` → 明确 support / validation / sealed test / canary 的不同可见性与使用次数；
5. `replay` → 第一版统一称 controlled re-execution；只有还原环境和动作语义的路径才称 replay；
6. `独立 evaluator` → 明确上下文、进程、artifact、身份与治理五个独立维度；
7. 实施计划阶段 3～4 → 改为两个 P0 可靠性机制实验，Experience 注入后移；
8. bandit 计划 → 增加 logging propensity 与 support coverage 前置 gate。

## 9. 研究依据的适用边界

外部工作支持当前方案的方向，但不能替代本项目的实证：

- [Next-Generation Agentic Reinforcement Learning Systems Enable Self-Evolving Agents](https://arxiv.org/abs/2607.01120) 支持 trajectory protocol、data proxy、evolution control plane 三层系统视角；它不是 meta-agent 当前闭环已就绪的证据。
- [GEPA](https://arxiv.org/abs/2507.19457) 在六类任务上报告比 GRPO 更少的 rollout 和更高的平均结果，说明自然语言反思优化值得试验；不能外推为所有 runtime 机制都能以相同样本效率提升。
- [ACE](https://arxiv.org/abs/2510.04618) 支持增量 playbook 和 context-collapse 风险，但其 benchmark 结果不能直接证明 meta-agent 的月级 park / wake、模型切换与 workspace 漂移问题已经解决。
- [Generalization in Adaptive Data Analysis and Holdout Reuse](https://arxiv.org/abs/1506.02629) 说明反复根据 holdout 结果选择新假设会对 holdout 本身过拟合。
- [Off-policy Bandits with Deficient Support](https://arxiv.org/abs/2006.09438) 与 [Optimal and Adaptive Off-policy Evaluation in Contextual Bandits](https://arxiv.org/abs/1612.01205) 说明 IPS / DR 需要 logging policy 与支持覆盖；普通确定性历史日志不自动满足这些条件。

## 10. 最终判定

当前方案不是“推倒重来”，而是需要把正确的治理原则变成可执行的信任链，并修正实施顺序。

**可以立即开始**：数据资格、evaluator trust 分级、Artifact Registry、Experiment Manifest、隔离 EvalRunner 的合成 fixture、canonical injection provenance，以及只读数据质量审计。

**暂不开始**：把 Reviewer Candidate 注入真实 Agent、根据反复查看的 held-out 结果演化 prompt、自动 canary / promotion、用普通历史日志做 IPS / DR，以及任何权重级训练。

当 G0～G2 完成后，下一次架构评审只回答一个问题：**Task Contract + Verifier 是否具备进入 shadow 实验的最小可信闭环**。在此之前，不以“自进化收益”作为项目进度指标。
