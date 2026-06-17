# 知识系统 v1(精简版)— 只跑 experience + anchor

状态:设计草案(当前主线)
取代:`anchor-integration-plan.md` 的双边关系部分降级为"未来升级",见文末
原则:不引入过度设计。principle 结构保留但不主动运行;anchor 与 experience **相互独立**,无双边关联。

---

## 1. 范围

**主动运行:** experience、anchor —— 两条**独立**的知识管线,各自:提取 → 待审 → 提交 → 召回。

**封存(代码保留,不在主线运行):**

- principle 全链路(`PrincipleConvergence`、收敛晋升、principle 召回/R7)——结构留着,不接线、不触发。
- anchor ↔ experience 双边关系(`anchor_ids` 认领回灌、反证传播、anchor→principle 回链、晋升接锚点)——代码留着,主线不调用。

砍掉双边的理由:现阶段证据不足以支撑这套联动的复杂度,先把两条独立管线跑顺、验证读侧真有用,再谈联动。

---

## 2. 提取点(capture)— 两个时刻,两类知识对齐

| 时刻 | experience | anchor |
|------|-----------|--------|
| **① 会话结束** | **新增** `_extractExperiencesPostSession`(Flash 扫 transcript → 经验候选) | 已有 `_extractAnchorsPostSession`(保持) |
| **② 用户主动 LLM 调用** | `experience_write`(保持) | `physical_anchor_write`(保持) |

两者都进各自 pending → 各自 review,**不交叉**。

### 2.1 新增:会话结束抽 experience

镜像现有 `_extractAnchorsPostSession`:`dispose()` 里加 `_extractExperiencesPostSession()`,Flash 读最近若干 assistant 轮次,产出经验候选 JSON 数组:

```
{domain,title,problem,solution,success,outcome_summary,abstract_principle,confidence_tier}
```

每条 → `experiencePendingStore.add` → `/experience review`。Flash 失败/不足 6 轮则静默跳过(与 anchor 抽取同策略)。

### 2.2 解耦:`experience_write` 回退为"只抽原则"

去掉之前合并蒸馏里的 anchor 提取(决策 A 的 anchor 部分),`experience_write` 只抽 `abstract_principle`(供经验召回匹配),**不再产出 anchor**。anchor 的自动入口统一为"会话结束抽取"。

> `anchor_ids` 字段在类型里保留(结构不删),但主线不再填充。

---

## 3. 审核(review)— 提交即止,不联动

- `/experience review`:提交经验 → **仅写入 ExperienceStore,不再调用 `evaluatePromotionForExperience`**(即不跑 anchor 认领、不跑 principle 认领/收敛/传播)。
- `/anchor review`:提交锚点 → 写入 PhysicalAnchorStore(不变)。

`evaluatePromotion` 及其下游(claim / 收敛 / 传播)**保留但不接线**。

---

## 4. 召回(recall)— 两条策略

### 4.1 Experience —— 相关性召回(已存在,保持)

每轮 submit 的 working-set 选择(Flash 相关性 → ContextPager → R2 渲染)。不改。

### 4.2 Anchor —— 全量 + memoize + 提交增量(改造 R6)

把 R6 从 `DANGEROUS_uncachedSystemPromptSection`(每轮重算)改成 **memoized 段落 + 提交时失效**:

- **首次进会话**:按 scope 全量加载(`global` 全部 + `robot` 匹配当前机器人 + `code` 本项目),全部渲染。
- **后续轮次**:memoized,字节不变 → 命中系统 prompt 缓存,零 Flash、零重算。
- **`/anchor review` 提交后**:`session.invalidateAnchors()` bump 版本 → 下一轮 R6 失效重建、增量纳入。
- 软上限(如 50)兜底极端膨胀,超限按 confidence+evidence 排序截断 + 提示用 `physical_anchor_search`。

```ts
// RoboticsSession
private _anchorVersion = 0
invalidateAnchors() { this._anchorVersion++; this.sections.invalidate('physical_anchors') }
```

> 不给 anchor 做每轮相关性召回:它少而稳,全量 memoize 既覆盖全、又缓存友好;每轮召回反而击穿缓存,是过度设计。

**principle 召回(R7)本期不做。**

---

## 5. 改动清单(按文件)

新增 / 改动:

- `RoboticsSession.ts` — 新增 `_extractExperiencesPostSession`(dispose 内调用);`_anchorVersion` + `invalidateAnchors()`;R6 改 memoized 全量;`/experience review` 路径**不再调** `evaluatePromotionForExperience`(由 CLI 改)。
- `dynamicSections.ts` — `buildR6Section` 改 memoized + 全量作用域加载 + 软上限,去掉每轮重算。
- `tools/experience_write/index.ts` — 蒸馏回退为只抽 `abstract_principle`,移除 anchor 提取与 `anchorStore`/`anchorPendingStore` 注入(或留参数但不用)。
- `cli/index.ts` — `/experience review` 提交回调改为"仅提交"(去掉 evaluatePromotion 调用与锚点信号打印);`/anchor review` 提交后调 `session.invalidateAnchors()`。

保留不动(封存):

- `PrincipleConvergence.ts`、`PrinciplePromotion.ts`(收敛/严格晋升/簇接锚点)、`claimAnchorsForExperience`、反证传播、`PrincipleStore`/pending、principle 工具与测试 —— 全部保留,主线不触发。

---

## 6. 风险与取舍

- **双路重复捕获:** 会话内已 `experience_write`、结束又抽一次,可能近似重复。v1 接受,靠 `/experience review` 人工过滤;后续可做写时去重。
- **会话结束抽取质量:** transcript-scan 由 Flash 产出结构化经验,字段可能不全/不准。缓解:沿用 anchor 抽取的保守策略(≥6 轮才抽、失败跳过)+ 人工 review 关口。
- **缓存友好:** anchor 全量 memoize → prompt 缓存命中(核心收益)。
- **可回退/可升级:** 所有封存代码原样保留,未来要开双边关系或 principle,直接按 §未来升级 重新接线即可。

---

## 未来升级(封存方案)

以下为已设计/已实现但本期**不运行**的能力,作为未来升级路径保留:

- **anchor ↔ experience 双边关系**:见 `docs/anchor-integration-plan.md`(经验认领锚点、三档 verdict 回灌、反证沿支撑边传播、anchor↔principle 回链、晋升接锚点)。
- **principle 全链路**:见 `docs/principle-mechanism-improvement.md`(收敛晋升、严格抽象判官)+ 本期跳过的 principle 召回(R7)。

升级触发条件参考:当 experience/anchor 两条独立管线在真实使用中被证明有用、且知识量足以让"同机制经验收敛""锚点被实验验证/推翻"频繁发生时,再逐步接线。
