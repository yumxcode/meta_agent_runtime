# Principle 机制改进方案

状态:设计草案
范围:`src/robotics/` 下的 principle / experience 链路
目标读者:实现者

---

## 1. 背景与目标

当前 principle 机制在"写入侧"设计严谨(双人工关口、严格校验、按 experienceId 去重),但两条作为核心卖点的反馈回路在日常流程里基本空转。本方案修复这些断点,并把"原则因收敛而稀疏"这一理念落到判据里。

### 1.1 现状的三个断点(审核结论)

1. **强化/反驳回路触发不到。** `RoboticsSession.reinforcePrinciplesFromExperience` 读经验的 `principleIds`,但该字段只能由 `ExperienceStore.appendPrincipleReference` 写入,而它仅在 `/principle review` 提交原则时回写到**源经验**;`experience_write` 没有 `principle_ids` 入参。回路只在 `/experience review` 提交经验那一刻被调用,此刻新经验的 `principleIds` 必为空 → 永远返回空。线上等同死代码。

2. **晋升阈值依赖一个永不增长的量。** `experienceRetrievalScore = 权重[tier] + min(obs,10)×8 − contra×40`,阈值 450。但经验的 `observationCount` 写入后无处递增(`ExperienceStore.write` 每次新建条目,无去重/合并,也无经验级 `recordObservation`)。结果:默认 observed 经验分数 408 < 450,自动晋升走不到;实际只有 agent 自报 `confidence_tier='reproduced'` 能晋升——又退回了阈值注释声称要修复的旧毛病,且 tier 是自评、系统不核验。

3. **已提交原则缺乏自动浮现。** 经验有 R2 索引段落 + `ExperiencePatternChecker` 主动 checkout;committed `PrincipleEntry` 没有任何自动注入通道,只有 agent 主动调 `principle_search` 才会被读到。产出成本(两次 Flash + 两道人工)与被动消费严重不匹配。

### 1.2 目标

- 让原则**因多条经验机制收敛而诞生**,而非从单条经验萃取;默认绝大多数经验既不产出也不引用原则。
- 接通强化/反驳回路:经验在真正命中已有原则时"认领"它,后续成败回灌为佐证/反证。
- 让 tier 由系统按证据计算,而非 agent 自报。
- 给原则读侧补一条自动浮现通道,使读写成本对等。

---

## 2. 设计原则

- **认领优先于生成(recognition over generation):** 新经验先看是否被已有原则覆盖,命中则认领(连接),只有无人覆盖且证据收敛时才生成新原则。
- **收敛而非提取:** 一条经验最多是"一个观察点";原则是若干独立观察点在同一机制上的收敛结果。
- **稀疏可追溯:** 原则数量应远少于经验数量,每条原则的 `derivedFromExperienceIds` 指向支撑它的整簇经验。
- **软信号入打分,而非硬门:** 来源多样性影响置信度与检索排名,不影响原则能否诞生。出生即审判交给人工 + 反证下沉的自我纠错。

> 说明:`abstractPrinciple`(每次 `experience_write` 由 Flash 抽的一行)保留,它是廉价的检索素材;它**不是**原则,过不了晋升门就只是经验自己的备注,不污染原则库。

---

## 3. 总体流程

### 3.1 经验提交时(`/experience review` 内,逐条已提交经验)

```
对每条刚提交进全局 ExperienceStore 的经验 exp:
  1. 认领:已有 committed 原则覆盖 exp 吗?(Flash 适用性判断)
       命中 → appendPrincipleReference(exp, principleId) 记上 ID
            → reinforcePrinciplesFromExperience(exp) 立即回灌成败信号
            → 不晋升,结束
  2. 收敛:无人覆盖 → 在 exp.domain 下"尚未关联原则"的经验里做 Flash 机制聚类
       若某簇(含 exp)达到 ≥ N 条不同经验 且 无未消解反证
            → 生成一条原则候选,derived_from = 整簇,tier 按来源多样性软算
            → 进 pending,等 /principle review
  3. 簇级去重:一个簇只晋升一次;之后同机制新经验在第 1 步被认领,转强化
```

触发时刻 = **让某簇跨过阈值的那条经验被提交的瞬间**,无论它来自哪个 session/项目(已提交经验是全局库,见 §3.3)。聚类 Flash 调用只在提交时跑、按 domain 限定、可缓存,不进热路径。

### 3.2 原则提交时(`/principle review` 内)

与现状一致:`validatePrincipleInput` 校验 → `PrincipleStore.write` → 回写 `derivedFromExperienceIds` 里所有源经验的 `principleIds`(已有逻辑,`PrinciplePendingStore.commit` 调用 `appendPrincipleReference`)。

### 3.3 隔离边界说明(不改,仅澄清)

- **已提交经验/原则:全局共享、跨 session 可见**(`ExperienceStore` / `PrincipleStore` 根目录在 `META_AGENT_HOME`,不带 session/project)。这是跨来源收敛的前提。
- **待审(pending):按 projectDir 隔离**。隔离边界是"审核"这道关,不是 session。

---

## 4. 数据模型变更

### 4.1 `ExperienceEntry`(types.ts)

`principleIds?: string[]` 字段已存在,无需新增;改的是**它的写入通道**(见 §5.1)。

不新增 `sourceProjectId` 硬字段。来源多样性用现有 `robot` / `sourceSessionId` 做软提示即可(只影响 tier 软算,定偏会被强化回路修正)。若日后要更精确的多样性,可再加,但不作为本方案承重件。

### 4.2 `experience_write` 工具 schema(tools/experience_write/index.ts)

新增可选入参:

```jsonc
"principle_ids": {
  "type": "array",
  "items": { "type": "string" },
  "description": "Committed principle IDs this experience applied or tested. Usually empty; set only when a known principle genuinely informed this work."
}
```

描述里强调"通常为空",避免诱导 agent 为每条经验硬凑。

### 4.3 `validateExperienceInput`(ExperiencePendingStore.ts)

透传并规范化 `principle_ids`(过滤非法 ID 格式,去重,限长),映射到 `principleIds`。这条是"显式认领"通道,作为 §5.1 自动认领之外的兜底。

---

## 5. 关键判据细节

### 5.1 认领:接通强化回路的核心

扩展 `ExperiencePatternChecker`(validation/built-in/FailurePatternChecker.ts)或新增一个兄弟钩子,使其除了召回历史**经验**外,也把 committed **原则**纳入 Flash 适用性候选。当 Flash 判定某原则适用于当前操作/经验时:

- 运行期(`experiment_dispatch` 前):照旧 checkout 进上下文,**并**把该原则 ID 暂存到本次任务上下文;
- 落地期(对应经验 `experience_write` / 提交时):把暂存的原则 ID 写入该经验的 `principle_ids`。

最小可行替代方案(若不想改运行期钩子):在 `/experience review` 提交每条经验时,对该经验单独跑一次 Flash 适用性判断(输入 = 经验的 problem/solution/abstractPrinciple + 同 domain 的 committed 原则候选),命中即 `appendPrincipleReference`。逻辑集中、改动面小,推荐先做这一版。

伪码(集中在提交钩子):

```ts
async function claimPrinciplesForExperience(exp): Promise<string[]> {
  const candidates = await principleStore.search({ domain: exp.domain, limit: 15 })
  if (candidates.length === 0) return []
  const applicableIds = await flashJudgeApplicable(exp, candidates) // 复用 PRINCIPLE_JUDGMENT_SYSTEM 思路
  for (const pid of applicableIds) await experienceStore.appendPrincipleReference(exp.id, pid)
  return applicableIds
}
```

### 5.2 收敛聚类与晋升

替换 `shouldTriggerPrinciplePromotion`(单经验)为 `findConvergentClusters`(域级)。

```ts
const N_CONVERGENCE = 3 // 起步阈值,可调

async function evaluatePromotion(exp): Promise<PromotionOutcome> {
  // 1. 认领优先
  const claimed = await claimPrinciplesForExperience(exp)
  if (claimed.length > 0) {
    await session.reinforcePrinciplesFromExperience(exp.id)
    return { kind: 'reinforced', principleIds: claimed }
  }

  // 2. 收敛聚类(仅未关联原则的同域经验)
  const pool = (await experienceStore.search({ domain: exp.domain, limit: 30 }))
    .filter(e => (e.principleIds ?? []).length === 0)
  const cluster = await flashClusterByMechanism(exp, pool) // 含 exp 的最大同机制簇
  if (cluster.length < N_CONVERGENCE) return { kind: 'none' }
  if (cluster.some(e => (e.contradictionCount ?? 0) > 0)) return { kind: 'none' } // 有未消解反证不晋升

  // 3. 簇级去重:簇内任一经验已关联原则则跳过(已被覆盖)
  if (cluster.some(e => (e.principleIds ?? []).length > 0)) return { kind: 'none' }

  const tier = diversityTier(cluster) // §5.3
  await proposePrincipleFromCluster(cluster, tier) // 进 pending
  return { kind: 'proposed', clusterIds: cluster.map(e => e.id) }
}
```

`flashClusterByMechanism`:输入 exp + 候选池,系统提示要求"按底层机制语义判断哪些经验和 exp 表达同一条可迁移规律,而非表面/关键词相似",返回与 exp 同簇的经验 ID 列表(含 exp)。沿用 §1 既定的"语义判定而非文本比对"。

`proposePrincipleFromCluster`:复用现有 `proposePrincipleFromExperience` 的 Flash 扩写(`PRINCIPLE_PROMOTION_SYSTEM`),但输入改为整簇经验块,`derived_from_experience_ids` = 全簇,`source_experience_id` = 触发的 exp。

### 5.3 来源多样性 → 置信度(软信号,非硬门)

不设独立性硬门(已讨论否决:太严会饿死合法单项目原则,且与人工关口/反证下沉/适用性推送三层重复)。改为入 tier:

```ts
function diversityTier(cluster): KnowledgeConfidenceTier {
  const sources = new Set(cluster.map(e => `${e.robot ?? '?'}::${e.sourceSessionId ?? e.id}`))
  return sources.size >= 2 ? 'reproduced' : 'observed'
}
```

- 单一来源收敛 → `observed`(基础分 400),原则照常诞生但姿态低、检索排名低;
- 跨来源印证 → `reproduced`(基础分 500),排名高、更易被推送。

多样性此后只影响 `principleRetrievalScore` 排名,不影响诞生。真有用靠后续认领→强化升到 reproduced,没用靠反证下沉。

### 5.4 阈值与打分的诚实化

晋升不再读经验的 `observationCount`(那个永不增长的量),改由"簇大小 ≥ N + 机制收敛 + 无反证"决定。`PRINCIPLE_PROMOTION_SCORE_THRESHOLD = 450` 及 `shouldTriggerPrinciplePromotion` 的单经验分数门废弃(保留 `explicit_user_request` 手动路径)。原则侧 `principleRetrievalScore`(`+min(obs,10)×10 − contra×50 + min(anchors,6)×12`)不变——它读的是**原则**的 obs/contra,这些由强化回路真实累加(见 §6),语义成立。

---

## 6. 强化/反驳回路接通

接通后回路自然转起来(`reinforcePrinciplesFromExperience` 本身不用改):

```
新经验 exp_g 提交 → claimPrinciplesForExperience 命中原则 P
  → exp_g.principleIds = [P]
  → reinforcePrinciplesFromExperience(exp_g):
       exp_g 成功 → P.recordObservation()   // observationCount+1, 分升, 更易被推
       exp_g 失败 → P.recordContradiction()  // contradictionCount+1, −50, 下沉
  → 反证累积 → P 在 /principle review 浮出复核(也许补 nonApplicableWhen)
```

时序确认:认领(§5.1)必须在 `reinforcePrinciplesFromExperience` 之前完成,二者都在 `/experience review` 提交单条经验的处理块内(cli/index.ts 当前 3673–3689 附近),顺序改为 **认领 → 强化 → 评估晋升**。

### 5.5 严格抽象:晋升步必须允许拒绝

`proposePrincipleFromCluster` 调用的 Flash 不是"收到簇就产出原则",而是**默认拒绝、达标才晋升**。"成簇"只是机制收敛的必要条件,不是充分条件——簇里可能只是表面相似、或讲的是一次性环境/版本坑、或是操作步骤而非因果约束。抽象出一条假原则比不抽象更有害:它会污染全局库、误导其他项目的 agent。

因此晋升 prompt 必须把"什么不该抽象"写死,并给一个显式弃权出口。

替换现有 `PRINCIPLE_PROMOTION_SYSTEM` 为(要点):

```
You evaluate whether a CLUSTER of robotics experiences justifies ONE reusable principle.
Default to REJECT. Most clusters do not deserve a principle. Do not abstract for the sake
of abstracting — a false principle pollutes the knowledge base and misleads future agents.
Return JSON only.

REJECT → {"promote": false, "reason": "<one sentence>"} when ANY holds:
  - The experiences are only superficially/coincidentally similar; no single shared
    causal or constraint mechanism actually links them.
  - You cannot state a mechanism (WHY it holds) grounded in physics/math/control/
    signal/statistics — restating the observation is NOT a mechanism.
  - It is a one-off fact, an environment/version/tooling quirk, or a workaround,
    not transferable within the domain.
  - It is an action recipe ("do X then Y") rather than a causal/constraint structure.
  - It is too vague to bound — you cannot state real preconditions or
    non-applicable conditions.
  - It merely restates something trivially obvious or true by definition.
  - Evidence is too thin or internally contradictory to trust.

PROMOTE → full schema with "promote": true ONLY when ALL hold:
  - A single transferable mechanism genuinely explains EVERY retained experience.
  - You can articulate why it holds from first principles.
  - You can state concrete boundaries: when it applies AND when it does not.
  - It would actually change a future agent's decision in this domain.

When promoting, also return "rejected_members": [exp ids in the cluster that do NOT
fit the mechanism — do not fold them in just to look stronger].

Rules:
  - Prefer rejecting over forcing a weak principle.
  - Bound narrowly; never overgeneralize beyond the evidence.
  - Do not invent measurements; use only provided evidence.
  - If only a subset shares the mechanism, promote on that subset and list the rest in
    rejected_members. If the qualifying subset drops below the convergence threshold,
    REJECT instead.
```

配套处理:

- `parsePrincipleProposal` 先看 `promote` 字段。`promote !== true` → 不入 pending,返回独立结果 `reason: 'rejected_by_judge'`(与 `flash_failed` 区分,前者是正常的"不值得",不该当错误重试)。
- `rejected_members` 里的经验从 `derivedFromExperienceIds` 剔除;若剔除后留存经验数 < N,整体按拒绝处理。
- 拒绝结果可缓存(同簇短期内不重复问),并可在 `/experience review` 输出一行 `dim` 提示"该簇暂不足以成为原则",便于人理解为何没产出。

> 同样的"默认克制"基调也适用于 §5.1 认领判断和 §5.2 聚类:`ExperiencePatternChecker` 现有 prompt 已写 "Be selective: false positives cause noise",聚类 prompt 也应要求"按机制而非表面相似,宁可分簇更细也不硬合并"。三步一致地偏向保守。

---

## 7. 读侧:committed 原则自动浮现

补齐与经验对等的浮现通道,二选一(或都做):

- **方案 A(推荐,改动小):** 在 §5.1 的适用性钩子里,Flash 判定适用的**原则**也 checkout 进 ContextPager(像现在对经验那样),tag 用 `[PRINCIPLE]`,优先级 high,TTL 几轮。这样 agent 在相关操作前自动看到该原则的 statement + 边界。
- **方案 B:** 新增一个动态系统提示段落(R 系列),按当前 domain/robot 列出最高分的若干条原则的标题 + statement,memoized,原则库变更时失效重建。

推荐先做 A:复用既有 ContextPager 机制,且天然与认领同源(判定适用时一并 checkout + 记 ID)。

---

## 8. 兼容与回填

- 存量经验未经聚类。提供**手动** `/principle backfill`:对历史经验按 domain 跑一遍 §5.2 的聚类与晋升(产物仍进 pending,人工确认),不自动扫全库,避免一次性灌入大量候选。
- 现有 committed 原则不受影响;`explicit_user_request` 手动晋升路径保留。
- `principleIds` 字段语义不变,仅多了写入来源。

---

## 9. 改动清单(按文件)

- `tools/experience_write/index.ts` — schema 加 `principle_ids`(可选,描述强调通常为空)。
- `ExperiencePendingStore.ts::validateExperienceInput` — 透传规范化 `principle_ids`。
- `validation/built-in/FailurePatternChecker.ts` — 适用性候选纳入 committed 原则;命中原则时 checkout + 暴露 ID(读侧浮现 + 认领)。
- 新增 `PrincipleConvergence.ts`(或并入 `PrinciplePromotion.ts`)— `findConvergentClusters` / `flashClusterByMechanism` / `claimPrinciplesForExperience` / `diversityTier` / `evaluatePromotion`。
- `PrinciplePromotion.ts` — 废弃单经验分数门 `shouldTriggerPrinciplePromotion`;`proposePrincipleFromExperience` 增加按簇输入的入口(或新增 `proposePrincipleFromCluster`);**重写 `PRINCIPLE_PROMOTION_SYSTEM` 为默认拒绝版(§5.5)**;`parsePrincipleProposal` 增加 `promote`/`rejected_members` 处理,弃权返回 `rejected_by_judge`。
- `RoboticsSession.ts` — 暴露 `evaluatePromotion` / 认领方法给 CLI;`reinforcePrinciplesFromExperience` 不变。
- `cli/index.ts` — `/experience review` 提交块改为 认领 → 强化 → 评估晋升;新增 `/principle backfill`。
- 测试:`PrinciplePromotion.test.ts` 增收敛/认领/强化用例;补聚类与去重的单测。

---

## 10. 风险与取舍

- **成本:** 每次经验提交多一次 Flash 适用性 + 可能一次聚类调用。均在 `/experience review`(非热路径)、按 domain 限定、可缓存。可接受。
- **聚类误判:** Flash 可能把不同机制聚到一起。缓解:N≥3 + **晋升步默认拒绝(§5.5)能剔除不合机制的成员甚至整簇否决** + 人工 `/principle review` 出生关 + 反证下沉。聚类失败时降级为不晋升(宁缺毋滥)。
- **弃权过度:** 严格 prompt 可能把本该成原则的簇也拒了。缓解:被拒簇的经验仍在库中,后续更多印证到来时会再次进入聚类重评;`explicit_user_request` 手动路径不受此判据约束,可人工强制晋升。
- **N 取值:** 起步 3,观察误报后调。同 session 短时窗连发可选折叠,先不做。
- **认领漏判:** Flash 没认出本应认领的原则 → 该经验可能误触发一条近似新原则。缓解:人工 review 时易识别重复并丢弃/合并;簇级去重也会拦下一部分。
- **未做语义级原则合并:** 两条不同经验簇得出语义相同的原则,系统不自动合并,仍靠人工 review 兜底(与现状一致)。
```
