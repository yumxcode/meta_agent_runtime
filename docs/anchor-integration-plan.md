# Physical Anchor 接入方案

状态:设计草案
范围:`src/robotics/` 下 physical anchor ↔ experience / principle 的打通
关联:`docs/principle-mechanism-improvement.md`(本方案镜像其管线)

---

## 1. 背景:anchor 当前是孤岛

唯一连接是 **principle → anchor**,且弱、单向、不校验:

- 晋升时 Flash 候选可填 `anchoredByPhysicalAnchorIds`,`principleRetrievalScore` 给带锚点原则加分(`+min(anchors,6)×12`),`principle_search` 可按 `anchorId` 过滤。
- 但 Flash 填的 anchor ID 无人校验存在性,anchor 侧无反向回链。

未连接的部分(本方案要补的):

1. **经验 ↔ anchor 零链路。** `ExperienceEntry` 无 anchor 引用字段。实验无法声明"我验证/推翻了某条物理事实"。
2. **anchor 无强化/反驳回路。** `PhysicalAnchorStore` 无 `recordObservation`/`recordContradiction`;`anchorScore = CONFIDENCE_WEIGHT[tier] + min(evidenceRefs,8)×10`,连计数字段都没有。物理事实被实验推翻也记不下来。
3. **anchor 不参与收敛管线。** `evaluatePromotion` 只认领 principle,从不碰 anchor。
4. **anchor 只能手写**(`physical_anchor_write`),无从经验派生的通道。

---

## 2. 设计原则(与 principle 的异同)

相同:经验对知识的"认领 + 成败回灌"回路、被反证下沉重审、读侧浮现。

关键不同 —— **anchor 是被断言的物理事实,不是被收敛出的规律**:

- **anchor 单次即可成立,无需收敛。** 物理事实("实测舵机负载下延迟 8ms")单次实验就是事实,因此**允许从单条经验自动提案**——这与 principle 必须跨多条经验收敛不同。但提案必须严格、并经人工 `/anchor review` 把关。
- **两个生成触发,同一审核关口(见 §3)。** (1) agent/用户主动 `physical_anchor_write`;(2) `experience_write` 时由 Flash 在总结经验的同一次调用里顺带严格审查。两者都进 `PhysicalAnchorPendingStore` → `/anchor review`。
- **信号语义更细。** principle 用"实验成功=佐证 / 失败=反证"。anchor 不能这么粗:一个实验失败不等于推翻某条物理事实。必须由判官**逐锚点判定** `corroborated`(实验结果与该事实一致)/ `contradicted`(观察到该事实不成立)/ `neutral`(用到但未提供证据)。只有前两者产生信号。

### 2.4 三者的关系模型(知识图)

三者构成一张三层知识图,各层回答不同问题:

- **Experience —— 证据层:** "这次任务发生了什么"。原子观察,数量最多,既不该稀疏也不该被强求升华。
- **Physical Anchor —— 事实层:** "硬件/物理上什么是真的"(实测延迟、行程极限、数据手册值)。
- **Principle —— 规律层:** "在什么机制下该怎么做"。

界线必须守住:anchor 是*事实*,principle 是*规律*。哪怕 `abstractionLevel='physical'`,原则仍是"因为 X 所以要 Y"的规则,而锚点是"X 就是 8ms"的事实。否则两者互相侵蚀。

四条边及其承载字段:

```
                  支撑·约束边界 / 反证传播
   Physical Anchor ─────────────────────────▶ Principle
        ▲                                          ▲
        │ 提出·校验                       派生·强化 │
        │ exp.anchorIds ⇄ obs/contra   principleIds ⇄ derivedFrom
        │                                          │
        └──────────────── Experience ─────────────┘
```

1. **经验 ⇄ 原则**(已实现,双向带信号):`experience.principleIds` ⇄ `principle.derivedFromExperienceIds`。派生(收敛晋升)+ 强化/反驳(认领回灌)。
2. **经验 ⇄ 锚点**(本方案在建,双向带信号):写经验时**提出**新锚点候选(§3.1),审经验时**校验**旧锚点(§3.2)。`experience.anchorIds` + 锚点 obs/contra 计数。
3. **锚点 → 原则**(现有,§7 补严):`principle.anchoredByPhysicalAnchorIds`。语义是**支撑与约束边界**——锚点是原则成立的物理前提,也划定其适用范围。

核心动态 —— **反证沿支撑边传播(§7):** 当一条经验推翻某锚点(物理前提变了),所有以该锚点为支撑的原则其地基已动摇,应自动标记降权、浮到 `/principle review` 复审。这是传递性挑战:经验 → 反证锚点 → 连带挑战所有引用该锚点的原则。捕捉的是"地基塌了,盖在上面的房子都要查"。对称的佐证传播(弱、可选)留后。

收敛汇合 —— **晋升时接锚点:** principle 收敛晋升时,簇内经验常共享同一批锚点;晋升 Flash 本就喂了候选锚点,应让它把**簇内经验共同验证过的锚点**填进新原则的 `anchoredByPhysicalAnchorIds`,使原则一出生即接地、支撑边自动建立。

---

## 3. 总体流程

### 3.1 生成:`experience_write` 时合并一次 Flash 审查

现在 `experience_write` 已有一次 Flash 调用抽 `abstractPrinciple`。**把 anchor 审查合并进这同一次调用**(决策 A),返回 JSON 同时给出原则一行 + 可选 anchor 候选:

```
experience_write.call():
  candidates = anchorStore.search({ domain, robot, limit 10 })   // 去重上下文(决策 B)
  raw = flash(EXPERIENCE_DISTILL_SYSTEM, exp + 已有 anchor 列表)  // 合并调用
  { abstract_principle, anchors[] } = parse(raw)                  // anchors 默认 []
  enrichedInput.abstract_principle = abstract_principle
  for a of anchors.slice(0, 2):                                   // 上限 2(决策 C)
      anchorPendingStore.add(a)                                   // → /anchor review
```

- 合并调用里两种取向分区写清:`abstract_principle` **每条必出**(宽松);`anchors` **默认空、严格**(默认不提,见 §6 prompt)。
- 去重:把该 domain 已有 anchor 喂给 Flash,要求"已锚定的事实不要重复提"(决策 B)。
- 上限:每条经验最多 2 条 anchor 候选,默认 0(决策 C)。
- 需把 `anchorStore`(committed,做去重上下文)+ `anchorPendingStore`(排队)接进 `createExperienceWriteTool`(现在只拿到 experience pending)。
- 另一入口 `physical_anchor_write` 不变。两条都汇入 `PhysicalAnchorPendingStore` → `/anchor review`。

### 3.2 验证:`/experience review` 提交时认领并回灌

在 `evaluatePromotion` 的认领阶段,principle 与 anchor 并行认领:

```
对每条刚提交的经验 exp:
  1a. 认领 principle(已实现):命中 → 连接 + 成败回灌
  1b. 认领 anchor(本方案新增):
        Flash 逐锚点判定 exp 是否验证/推翻了候选 anchor
        命中 → appendAnchorReference(exp, anchorId)
             → verdict=corroborated  → anchor.recordObservation()
             → verdict=contradicted → anchor.recordContradiction()(降权下沉,/anchor 复核)
             → verdict=neutral       → 仅连接,无信号
  2. 收敛 principle(已实现,与 anchor 互不阻塞)
```

anchor 认领**不影响** principle 的认领/收敛分支;二者都跑,各记各的。

> 生成(3.1)与验证(3.2)分处两个时刻:写经验时**提出**新物理事实,审经验时用经验**校验**已有物理事实。两者经手的是不同的 anchor。

---

## 4. 数据模型变更

### 4.1 `ExperienceEntry`(types.ts)

新增 `anchorIds?: string[]`(经验验证/依赖的物理锚点),与现有 `principleIds?` 对称。

### 4.2 `PhysicalAnchorEntry`(types.ts)

新增两个信号位(默认 0):

```ts
observationCount?: number    // 被实验佐证的次数
contradictionCount?: number  // 被实验推翻/违背的次数
```

### 4.3 `anchorScore`(PhysicalAnchorStore.ts)

折入信号项,与 principle 同构(注意 anchor 的 tier 权重表本就不同):

```ts
function anchorScore(a: PhysicalAnchorEntry): number {
  return CONFIDENCE_WEIGHT[a.confidenceTier]
    + Math.min(a.evidenceRefs.length, 8) * 10
    + Math.min(a.observationCount ?? 0, 10) * 8
    - (a.contradictionCount ?? 0) * 50
}
```

反证重罚使被推翻的物理事实在 `physical_anchor_search` 中下沉,浮出供人复核(可能要改 `fact` 或 `invalidates`)。

### 4.4 输入透传

- `experience_write` schema 加可选 `anchor_ids`(描述强调"通常为空,仅当实验确实验证/依赖某物理事实时填",与 `principle_ids` 一致)。
- `validateExperienceInput` 规范化 `anchor_ids`(校验 `pa_` 格式、去重、限长)→ `anchorIds`。
- `ExperiencePendingStore.commit` 映射 `anchorIds` 到 `store.write`。

---

## 5. PhysicalAnchorStore 新增方法

镜像 `PrincipleStore.recordOutcomeSignal`:

```ts
async recordOutcomeSignal(id: string, kind: 'observation' | 'contradiction'): Promise<PhysicalAnchorEntry | null> {
  const a = await this.load(id)
  if (!a) return null
  const updated = {
    ...a,
    observationCount: (a.observationCount ?? 0) + (kind === 'observation' ? 1 : 0),
    contradictionCount: (a.contradictionCount ?? 0) + (kind === 'contradiction' ? 1 : 0),
    lastVerifiedAt: kind === 'observation' ? Date.now() : a.lastVerifiedAt,
    updatedAt: Date.now(),
  }
  await atomicWriteJson(join(this.dir, `${id}.json`), updated)
  await this._upsertManifest(updated).catch(() => undefined)
  return updated
}
recordObservation(id) { return this.recordOutcomeSignal(id, 'observation') }
recordContradiction(id) { return this.recordOutcomeSignal(id, 'contradiction') }
```

`ExperienceStore` 加 `appendAnchorReference(experienceId, anchorId)`(与 `appendPrincipleReference` 同构,写 `anchorIds`)。

---

## 5.5 合并蒸馏 prompt(experience_write,决策 A)

替换 `experience_write` 现有的 `PRINCIPLE_SYSTEM`(纯文本返回原则一行)为合并版,返回 JSON。两种取向在 prompt 里分区写明:原则**每条必出**、anchor**默认空且严格**。

```
You distill one completed robotics experience into reusable knowledge. Return JSON only:
{"abstract_principle": "<one line>", "anchors": [ <0-2 anchors> ]}

abstract_principle — ALWAYS produce one concise, domain-bounded, mechanistic line
(the single most transferable lesson). 1-2 sentences.

anchors — DEFAULT to []. Most experiences yield no anchor. Do NOT extract for the sake of it.
An anchor is a CONCRETE device/physics fact an LLM would otherwise ignore or get wrong —
a measured limit, hardware behavior, datasheet/spec value, or reproducible quirk.
It is NOT a transferable mechanism (that is abstract_principle) and NOT a task step.
Add an anchor ONLY when ALL hold:
  - a concrete, specific physical/device fact grounded in THIS experiment's evidence
    (a measurement, observation, or cited spec);
  - it would change future planning or debugging;
  - it is NOT already in the "Known anchors" list below (do not duplicate).
Omit anything vague, speculative, one-off, or common knowledge. Max 2 anchors.
Each anchor: {domain, scope, fact, mechanism?, implication, confidence_tier, evidence_refs}

Example — anchor: "Go2 actuator latency ≈ 8 ms under load"; principle: "latency must be
bounded relative to control-loop frequency". The first is a concrete fact, the second a rule.
```

user 内容追加"Known anchors:"清单(该 domain 已有 anchor 的 title+fact),供去重(决策 B)。
解析后 `anchors` 截断到 2 条(决策 C),逐条 `anchorPendingStore.add(...)`;`abstract_principle` 仍写入 `enrichedInput`。Flash 失败/超时则降级为无原则、无 anchor(经验照常入队)。

---

## 6. 验证回路集成(PrincipleConvergence.ts)

新增 `claimAnchorsForExperience`,并在 `evaluatePromotion` 认领阶段调用。

```ts
const ANCHOR_CLAIM_SYSTEM = `\
You decide whether a robotics experience validated or contradicted stored physical anchors
(device/physics facts). For each candidate anchor the experience genuinely bore on, output a
verdict — judged by whether the experiment's evidence is consistent with the fact:
  corroborated — the experiment's outcome is consistent with the anchor's fact
  contradicted — the experiment observed the fact NOT to hold
  neutral      — the experiment used/assumed the fact but provides no evidence either way
Be selective. Omit anchors the experiment did not actually bear on. Return JSON only:
{"verdicts":[{"id":"pa_...","verdict":"corroborated|contradicted|neutral"}], "reasoning":"..."}
Do NOT return IDs absent from the candidate list.`

export async function claimAnchorsForExperience(
  exp, experienceStore, anchorStore, flash,
): Promise<Array<{ anchorId: string; verdict: 'corroborated'|'contradicted'|'neutral' }>> {
  const candidates = await anchorStore.search({ domain: exp.domain, robot: exp.robot, limit: 15 })
  if (candidates.length === 0 || !flash) return []
  const raw = await flash.query({ system: ANCHOR_CLAIM_SYSTEM, user: /* exp + candidates */,
    maxTokens: 220, timeoutMs: 8000, cacheKey: `anchor-claim:${exp.id}:${ids.sort().join(',')}` })
  const verdicts = parseVerdicts(raw, new Set(candidates.map(c => c.id)))
  for (const v of verdicts) {
    await experienceStore.appendAnchorReference(exp.id, v.anchorId).catch(() => undefined)
    if (v.verdict === 'corroborated') await anchorStore.recordObservation(v.anchorId).catch(() => undefined)
    else if (v.verdict === 'contradicted') await anchorStore.recordContradiction(v.anchorId).catch(() => undefined)
  }
  return verdicts
}
```

`evaluatePromotion` 在 principle 认领之后、收敛之前插入 anchor 认领,并把结果并入返回:

```ts
const anchorVerdicts = await claimAnchorsForExperience(trigger, deps.experienceStore, deps.anchorStore, deps.flash)
// principle 'reinforced' / 'proposed' / 'none' 的返回里附带 anchorVerdicts(供 CLI 打印)
```

`EvaluatePromotionResult` 各分支可加可选 `anchorSignals?: {...}[]`,或在 reinforced/none 上挂。CLI 据此打印 `⚓ 锚点 pa_…: +1 佐证 / +1 反证(已降权)`。

`EvaluatePromotionDeps` 已含 `anchorStore`,无需改签名。

---

## 7. 锚点 ↔ 原则双向边 + 反证传播

### 7.1 收紧 principle → anchor(存在性校验 + 回链)

`PrinciplePendingStore.commit` 提交原则时:

- 校验 `anchoredByPhysicalAnchorIds` 里每个 ID 经 `isPhysicalAnchorId` 且 `anchorStore.load` 存在,剔除不存在的(给 commit 传入 `anchorStore`)。
- 反向回链:`PhysicalAnchorEntry` 加 `principleIds?: string[]` + `anchorStore.appendPrincipleReference(anchorId, principleId)`,提交时回写。**反证传播需要这条回链**,因此从"可选"升级为必做(否则只能退化为 `principle_search({anchorId})` 反查,慢且依赖索引)。

### 7.2 反证传播

`PhysicalAnchorStore.recordContradiction` 后,沿回链找出所有引用该锚点的原则,给每个记一次"间接反证"并标记待复审:

```ts
// 在 claimAnchorsForExperience 判定某锚点 contradicted 后:
const anchor = await anchorStore.recordContradiction(anchorId)
for (const pid of anchor?.principleIds ?? []) {
  await principleStore.recordContradiction(pid).catch(() => undefined)  // 地基动摇 → 原则降权下沉
}
```

- 用 `principle.recordContradiction` 复用现成的降权/下沉机制(扣 50 分,浮到 `/principle review`)。
- 只传播 `contradicted`,不传播 `corroborated`(佐证传播弱、可选,留后)。
- 传播是单跳(锚点→直接引用它的原则),不做多跳级联,避免雪崩;原则被连带降权后由人工复审决定是否改 `nonApplicableWhen` 或废弃。

---

## 8. 读侧

anchor 已通过 R6 / `PhysicalAnchorSource` 浮现,本方案不改。可选:`claimAnchorsForExperience` 命中的 anchor 一并 checkout 进 ContextPager(与 principle 读侧方案 A 对称),让 agent 操作前看到相关物理事实。

**互为索引(读侧交叉引用):** 三节点在读取时应互相带出,而非孤立列表。

- `principle_load`:已列源经验 + 锚点(现状保留)。
- `anchor_load`:补列"哪些经验校验过我(`experience.anchorIds` 反查)、哪些原则依赖我(`anchor.principleIds`)"。
- `experience_load`:已列 `principleIds`,补列 `anchorIds`。

这样 agent 拿到任一节点,能顺着边走到相邻知识。

---

## 9. 改动清单(按文件)

- `types.ts` — `ExperienceEntry.anchorIds?`;`PhysicalAnchorEntry.observationCount?/contradictionCount?`(可选 `principleIds?`)。
- `PhysicalAnchorStore.ts` — `recordOutcomeSignal`/`recordObservation`/`recordContradiction`;`anchorScore` 折入信号项;(可选)`appendPrincipleReference`。
- `ExperienceStore.ts` — `appendAnchorReference`。
- `tools/experience_write/index.ts` — schema 加 `anchor_ids`;**`PRINCIPLE_SYSTEM` 换成合并蒸馏 prompt(§5.5),返回 `{abstract_principle, anchors[]}`**;`createExperienceWriteTool` 接入 `anchorStore`(去重上下文)+ `anchorPendingStore`(排队);解析 anchors 截断 2 条逐条入 pending。
- `tools/index.ts` — 给 `experience_write` 注入 `anchorStore` + `physicalAnchorPendingStore`(后者已在容器内,见 RoboticsSession 599)。
- `ExperiencePendingStore.ts` — `validateExperienceInput` 透传 `anchor_ids`;commit 映射 `anchorIds`。
- `types.ts` — `PhysicalAnchorEntry.principleIds?`(反向回链,反证传播需要)。
- `PhysicalAnchorStore.ts` — `appendPrincipleReference`(回链)。
- `PrincipleConvergence.ts` — `claimAnchorsForExperience` + `ANCHOR_CLAIM_SYSTEM` + `parseVerdicts`;并入 `evaluatePromotion`;**反证传播**:某锚点判 `contradicted` 后,沿 `anchor.principleIds` 给每条原则 `recordContradiction`(§7.2)。
- `PrinciplePromotion.ts` — `proposePrincipleFromCluster` 把簇内经验共同验证的锚点填入 `anchored_by_physical_anchor_ids`(晋升时接锚点,§2.4)。
- `PrinciplePendingStore.ts` — commit 校验 anchor ID 存在性 + 回写 `anchor.principleIds`。
- `tools/anchor_load`/`experience_load`/`principle_load` — 互为索引补列(§8)。
- `cli/index.ts` — `/experience review` 输出锚点信号行 + 反证传播提示(`⚠ 原则 pr_… 因锚点反证连带降权`);(可选)`/anchor` 复核入口对齐 `/principle`。
- 测试:`PhysicalAnchorStore.test.ts`(recordOutcome + 打分);`ExperienceWriteTool.test.ts` 增合并蒸馏(原则必出 / anchor 默认空 / 提取上限 2 / 去重不重复 / Flash 失败降级);`PrincipleConvergence.test.ts` 增 anchor 认领/三类 verdict/反证降权/反证传播(锚点 contradicted → 关联原则被降权)/`anchor_ids` 透传用例。

---

## 10. 风险与取舍

- **verdict 误判:** Flash 可能把"实验失败"误判成"推翻物理事实"。缓解:prompt 明确三档语义 + 默认 neutral 倾向 + 反证只降权不删除 + 人工复核;低置信场景宁可 neutral。
- **合并调用稀释严格性(决策 A 代价):** 原则"必出"与 anchor"默认空"放进一个 prompt,模型可能为了"凑齐 JSON"而硬塞 anchor。缓解:prompt 分区写死两种取向 + `anchors` 默认 `[]` + 上限 2 + 去重清单 + `/anchor review` 人工关口。若线上发现 anchor 过度提取,可回退为独立第二次调用。
- **自动提案 anchor 的质量:** 单次实验即提物理事实,可能引入测量噪声或臆测。缓解:严格 prompt(要求 grounded in evidence)+ 人工 `/anchor review` + 后续验证回路(§3.2)对错误 anchor 反证下沉。
- **成本:** 生成侧合并进现有 Flash 调用,**不新增调用**(决策 A 的收益);验证侧每条经验提交多一次 anchor 认领 Flash(8s、按 domain+robot 限定、可缓存),与 principle 认领同级,非热路径。
- **与 principle 管线解耦:** anchor 认领失败/超时不影响 principle 认领与收敛(各自 catch 降级)。
- **反证传播雪崩:** 一个锚点被反证可能连带一批原则降权。缓解:只做**单跳**(锚点→直接引用它的原则),不级联;只传播 contradicted 不传播 corroborated;降权不删除,最终由 `/principle review` 人工裁定。这是有意的"保守扩散"——宁可多提示人复核,不自动废弃。
- **范围:** v1 做全:经验↔anchor 回路 + principle↔anchor 双向边 + 反证传播 + 互为索引;佐证传播、读侧 checkout 列为可选后续。
```
