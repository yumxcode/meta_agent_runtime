# 知识召回(读侧)对齐方案 — anchor / principle 参照 experience

状态:设计草案
范围:`src/robotics/`、`src/context/sources/` 读侧召回
关联:回应"写侧做厚、读侧做薄"的审核结论

---

## 1. 现状:三层知识的召回强度严重不均

| 知识 | 索引/清单 | 任务相关性召回 | 常驻槽 | 按需拉取 |
|------|-----------|----------------|--------|----------|
| Experience | R2 manifest | ✅ working-set(每轮 Flash 相关性 → ContextPager → R2 渲染) | — | search/load |
| Anchor | R6 manifest | ❌ **无** | ✅ 优先槽(global/robot top-3,常驻、非相关性) | search/load |
| Principle | ❌ 无段落 | ❌ **无** | ❌ | search/load(纯拉取) |

关键代码事实:

- experience 召回完整:`RoboticsSession` 每次 submit 跑 `EXPERIENCE_RELEVANCE_SYSTEM` Flash 相关性选择,`contextPager.checkout` 选中的经验,`buildR2Section(store, this.contextPager, ...)` 渲染。
- **R6 传入的 pager 是 `undefined`**(`buildR6Section(this.physicalAnchors, undefined, ...)`),所以锚点只有常驻优先槽,**不随当前任务召回**——一条 code-scoped 或非 top-3 的相关锚点,当前任务根本看不到。
- principle **没有任何自动浮现**,全靠 agent 主动 `principle_search`。

结论:我们花最大力气收敛出的 principle 读侧最弱;anchor 只能"常驻几条"而非"按需召回"。读侧是价值兑现点,必须补齐。

---

## 2. 设计目标

给 anchor 和 principle 补上自动浮现,但**两者策略不同**(见 §3),并放到合适的 prompt 位置。原则:

- **复用现成机制**:ContextPager、QueryAnalyzer intent、Flash 相关性判断、memoized 段落都已存在,不另起炉灶。
- **anchor 全量 + memoize**:物理事实少而稳,首轮按会话作用域全量注入、跨轮字节不变(命中 prompt 缓存),仅 `/anchor review` 提交后增量。无每轮 Flash。
- **principle 相关性召回**:原则数量多、跨域杂、任务相关,**不常驻 dump**(否则噪声 + 击穿缓存),只在与当前任务相关时经 Flash 浮现。

> 注:committed anchor 实为全局存储(非按项目),用 `scope` 字段(global / 本 robot / 本项目 code)界定"本会话作用域"。

---

## 3. 两种策略,而非一刀切

anchor 与 principle 召回需求不同,各用各的:

| | 数量/稳定性 | 策略 | 变更时机 | prompt 缓存 |
|---|---|---|---|---|
| Anchor | 少、稳定、安全事实 | **全量注入 + memoize** | 仅 `/anchor review` 提交 | ✅ 跨轮字节不变,命中缓存 |
| Principle | 多、跨域杂、任务相关 | **相关性召回**(Flash + pager) | 随当前任务 | 随任务变(可接受) |

关键认识:给 anchor 做每轮相关性召回是**过度设计**,而且每轮变动会**击穿系统 prompt 缓存**。anchor 稳定且少,首轮全量注入、保持字节不变,反而更省 Flash、更省 token、更快。principle 数量多无法全量 dump,才需要相关性召回。

ContextPager 隔离仅对 principle 需要(anchor 不再用 pager):

```ts
private readonly experiencePager = new ContextPager({ maxBudget: 1500 }) // 现 contextPager 沿用
private readonly principlePager  = new ContextPager({ maxBudget: 800 })
```

---

## 4. Anchor:全量注入 + memoize + 提交增量

把 R6 从现在的 `DANGEROUS_uncachedSystemPromptSection`(每轮重算)改成 **memoized 段落 + 提交时失效**,与 R2"experience_write 时重建"同模式。

行为:

- **首次进会话**:按本会话作用域全量加载 = `scope:global` 全部 + `scope:robot` 且匹配当前 robot + `scope:code`(本项目)。全部渲染进 R6。
- **后续轮次**:memoized,内容字节不变 → 命中 prompt 缓存,零 Flash、零重算。
- **`/anchor review` 提交后**:bump anchor 版本 → 下一轮 R6 失效重建 → 增量纳入新提交的锚点。

```ts
// RoboticsSession
private _anchorVersion = 0
invalidateAnchors() { this._anchorVersion++; this.sections.invalidate('physical_anchors') }
// /anchor review 提交成功后调用 session.invalidateAnchors()(会话内增量);
// 会话重启时首轮即全量,天然覆盖。
```

`buildR6Section` 改为 memoized,key 含 `_anchorVersion`;内部 `anchorStore.search` 不再只取 top-3,而是取本会话作用域**全量**(给一个软上限如 50 防极端膨胀,超限按 confidence+evidence 排序截断并提示"用 physical_anchor_search 看更多")。不再传 pager。

> 软上限存在的意义只是兜底;anchor 本就低量,正常情况下全量就是几条到十几条。

---

## 5. Principle:相关性召回(R7)

principle 数量多、任务相关,保留 Flash 相关性召回 → principlePager → R7 渲染。

在现有 experience working-set 选择之后(同一 submit、复用同一 intent),对**同域 principle 候选**做一次相关性选择:

```ts
async function selectPrinciplesForTask(prompt, intent) {
  const principles = await principleStore.search({ domain, limit: 12 })
  if (principles.length === 0) return
  const raw = await flash.query({
    system: PRINCIPLE_RECALL_SYSTEM,
    user: formatCandidates(prompt, intent, principles),
    maxTokens: 200, timeoutMs: 8000,
    cacheKey: `principle-recall:${hash(prompt)}:${ids.sort().join(',')}`,
  })
  for (const p of principles.filter(x => parseIds(raw).includes(x.id)))
    principlePager.checkout({ id:`principle:${p.id}`, tag:`§ ${p.title}`, content: formatPrincipleSlot(p), priority:'high', ttlTurns:3 })
}
```

`PRINCIPLE_RECALL_SYSTEM`(默认克制):

```
You select stored principles that genuinely inform the CURRENT task.
Judge by mechanism/applicability within the domain, not surface or keyword similarity.
Be selective — false positives waste context. Omit anything not directly relevant.
Return JSON: {"principles":["pr_..."]}. Empty array is correct when nothing applies.
```

复用 experience 的"是否需要重选"门控(domain/keyword 无重叠才重算)+ 缓存,避免每轮都调。Flash 失败/超时 → 不注入。

> 可选合并:把 principle 候选并进现有 experience working-set 那次 Flash 调用,返回两类 ID,做到"一次调用选两类"。先独立实现、稳定后再合并。

### R7 段落(新增)

```ts
export function buildR7Section(principleStore, principlePager, principleSource) {
  // Layer 1 manifest: "Principles: 12 total | locomotion:4 perception:3"
  // Layer 2: principlePager 相关性槽(无常驻 dump)
  // 空库 → 一行提示,零噪声
}
```

新增 `PrincipleSource`(镜像 `PhysicalAnchorSource`):`getManifestLine()` + 候选辅助。

### prompt 位置(权威性梯度)

volatile extensions 顺序调整为:**R6 锚点(事实)→ R7 原则(规律)→ R2 经验(证据)→ R3 任务态**。

理由:事实最权威、读最前;规律次之;经验是原始证据;任务态最末。三类知识相邻成簇,agent 一眼看到"已知事实 + 适用规律 + 相关教训"。

---

## 6. 改动清单(按文件)

- `RoboticsSession.ts` — 新增 `principlePager`(anchor 不需要 pager);`_anchorVersion` + `invalidateAnchors()`;新增 `selectPrinciplesForTask`(或并入现有 working-set 选择);R6 改 memoized 全量、提交时失效;注册 R7;调整 volatile/stable 段落顺序;构造 `PrincipleSource`。
- `dynamicSections.ts` — `buildR6Section` 改为 memoized + 全量作用域加载 + 软上限,去掉 pager 路径;新增 `buildR7Section`。
- `cli/index.ts` — `/anchor review` 提交成功后调用 `session.invalidateAnchors()`(会话内增量)。
- `context/sources/PrincipleSource.ts` — 新增(getManifestLine + 候选辅助)。
- 召回 prompt 常量 `PRINCIPLE_RECALL_SYSTEM` + 解析。
- 测试:R6 全量渲染 + memoize(同版本不重算)+ 提交后失效增量;R7 渲染(空库/有内容);principle 召回(命中/空/Flash 失败降级);principlePager 隔离(不串进 R2)。

---

## 7. 成本与风险

- **成本**:anchor 零增量 Flash(全量 memoize,跨轮命中 prompt 缓存);principle 每轮最多多一次 Flash,受"是否需要重选"门控 + 缓存;合并进 experience 选择后可归零增量。
- **缓存友好**:anchor 块字节稳定 → 系统 prompt 缓存命中,既省钱又降延迟;这是选"全量 memoize"而非"每轮相关性召回"的核心收益。
- **噪声**:principle 不常驻、相关性默认克制(prompt 要求 selective),空库零渲染。anchor 全量但本就低量,软上限兜底极端膨胀。
- **预算挤占**:principlePager 独立 maxBudget,TTL 3 轮自动回收;anchor 全量受软上限约束。
- **失效正确性**:会话内 `/anchor review` 提交 → `invalidateAnchors()` 增量;会话重启 → 首轮全量,两条路径都覆盖,无遗漏。
- **与写侧解耦**:召回/加载失败不影响任何写侧;纯读增强。
- **回退**:R7、principle 召回、R6 memoize 化都可单独关闭,不影响现有写侧与 R2。
```
