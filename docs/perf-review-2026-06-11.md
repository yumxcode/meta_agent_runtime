# Meta-Agent Runtime 性能审查（运行速度）

> **实施状态（2026-06-11）**：P0-1、P0-2、P1-1、P1-2、P1-3、P2-1、P2-2 已全部实现并验证
> （typecheck 通过，538 项测试全绿，含为预取语义新增的 5 项回归测试）。
> 代码注释带 `P?-?` 标记。P2-3（预测式 compact）与 P3（bundle minify）按报告建议**未**实施。
>
> 针对慢速 provider（首 token 15–30s）的适配：所有侧调用超时**未收紧**，改为 env 可调
> （`META_AGENT_MEMORY_RECALL_TIMEOUT_MS`，默认 3s，上限 120s；预取客户端的 SDK 超时随其联动）。
>
> 并行化的竞态防护（P0-1 预取契约，详见 findRelevantMemories.ts 注释）：
> single-flight（同 query+dir 只发一次）；consume-once（await 前删除条目，本轮内存写入
> 不会被下一轮的陈旧缓存掩盖）；兼容性校验（影响结果的全部选项逐字段比对，不匹配即丢弃
> 预取、走全新计算——正确性永不依赖预取）；失败隔离（预取 rejection 立即被观察，消费方
> 自动回退全新计算，不会触发 CLI 的 unhandledRejection 致命路径）；TTL 60s + 容量上限 8
> 兜底未被消费的条目。git 状态缓存（P1-1）经由互斥锁单点失效，覆盖全部变更路径；目录扫描
> 缓存（P1-2）以 dir mtime（原子 rename 必然触发）+ 30s TTL（覆盖原位手改）双层失效。

- 日期：2026-06-11
- 版本：0.2.10（含同日健壮性修复）
- 方法：热路径精读 + 微基准量化（tsx 实测）+ 启动耗时实测
- 核心结论：**CPU 侧热路径健康（每轮 < 0.1ms），墙钟时间几乎全部消耗在串行的 LLM 侧调用、子进程和网络上**。优化应集中在"减少关键路径上的等待"，而非计算优化。

## 实测数据

| 项目 | 实测值 | 说明 |
|---|---|---|
| applyToolResultBudget（每轮） | 0.02 ms | 合成 180k-token 历史（60 轮 ×30KB tool_result） |
| buildMessagesToKeepAfterCompact（每轮） | 0.06 ms | 同上；即便不触发 compact 也每轮计算 |
| import dist/index.js | ~409 ms | FUSE 挂载盘；本地 SSD 预计 100–200ms |
| @anthropic-ai/sdk / openai 导入 | 35 / 84 ms | 已被 2.2MB 单文件 bundle 吸收 |
| ModeDetector flash 分类 | ~300–500 ms（代码注释自报） | 每会话首条消息一次 |
| D1b 内存召回 flash 调用 | 典型 0.5–1.5s，超时上限 3s | **每个用户回合一次，串行在首 token 之前** |

---

## P0 — 关键路径上的串行 LLM 侧调用（最大收益）

### P0-1 首 token 前的串行等待链可并行化

用户按下回车后的实际顺序（agentic/robotics 模式）：

```
ModeDetector.detect (flash, ~0.4s)          SessionRouter.ts:289
  → 会话初始化
  → buildVolatileContextSections
      → findRelevantMemories (flash, ~0.5–1.5s)   dynamicPrompt.ts:116
  → 主模型首次请求
```

两次 flash 调用相互独立：mode 分类只需要 prompt 文本，内存召回只需要 query。把 memory recall 的 Promise 在 detect 之前就启动（或 `Promise.all`），首 token 延迟可稳定减少 0.3–1.5s。这是整个代码库里**性价比最高的单项优化**。

### P0-2 内存召回每回合都挡在首 token 前

`buildMemoryContentSection`（dynamicPrompt.ts:98）每个用户回合都串行执行 flash 相关性筛选。建议（按实施成本排序）：

1. 超时从 3s 降到 1.5s（findRelevantMemories.ts:308）——失败回退 keyword 匹配本来就有，长尾等待不值得。
2. 候选数 ≤ 注入上限（EXPERIENCE_INJECTION_LIMIT / maxCandidates）时跳过 flash 直接全量注入——小内存库（多数用户）完全绕开侧调用。
3. 以 `(query 哈希, 目录最大 mtime)` 为键缓存筛选结果——同一问题重试/steer 后重提时零开销。

---

## P1 — 子进程与磁盘 I/O

### P1-1 robotics R3 节区：每回合每活跃任务 4 个 git 子进程

`buildR3Section`（robotics/dynamicSections.ts:222）对每个活跃子代理并行跑 `rev-list ×2 + log ×2`。单任务约 +20–80ms/回合，活跃任务多时线性叠加，且在首 token 关键路径上。建议给 `getTaskBranchStatus` 加 5–10s 微缓存（D8/D10 已有 500ms micro-cache 的现成模式，git 分支状态的时效性要求更低）。

### P1-2 memory 目录扫描每回合全量 readdir + 逐文件 readPrefix/stat

`scanTopicFiles`（findRelevantMemories.ts:138）温缓存下 1–5ms，文件数逼近 MAX_TOPIC_FILES_TO_SCAN 时上升。建议以目录 mtime 为键缓存 header 列表（目录未变则直接复用）。

### P1-3 instrumentTool 的隐性开销（工程模式）

instrumentTool.ts 每次工具调用：

- 第 138 行对**所有**成功输出尝试 `JSON.parse(result.content)`——纯文本快速失败没问题，但 `read_file` 读出的大 JSON 文件会被完整 parse 一遍且仅用于 V&V。建议先看首个非空白字符是否 `{`/`[` 再 parse，并设大小上限（如 256KB）。
- 第 157 行 provenance 记录把完整 `input` 落盘——`write_file` 的 content 等于全量写两份。建议对超过阈值的输入字段截断并存哈希引用。

---

## P2 — 调度与网络

### P2-1 子代理串行错峰启动 250ms

`DEFAULT_SUB_AGENT_START_DELAY_MS = 250`（SubAgentBridge.ts:40）：4 个并发任务尾部多等 750ms。除非是针对 provider 限速，否则降到 50ms 即可（env 可调已具备，改默认值）。

### P2-2 buildMessagesToKeepAfterCompact 可延迟计算

KernelLoop.ts:534 每轮迭代都计算 messagesToKeepAfterCompact（含第二次 applyToolResultBudget），但仅在 compact 实际触发时使用。实测仅 0.06ms——不是性能问题，但 `shouldAutoCompact` 探针已经在前面（539 行），把计算移进条件分支是零风险的整洁化，顺便消除"每轮两次 budget"的认知负担。

### P2-3 compact 同步阻塞（已知权衡，列为可选）

compact 触发时主回路同步等待 flash 摘要（数秒级）。已有 `compact_start` 事件兜住体验。可选的进阶优化是"预测式后台 compact"（接近阈值时在等待用户输入的空闲期提前压缩），但状态机复杂度高、收益场景窄，**不建议现在做**。

---

## P3 — 启动与杂项

- CLI bundle 2.2MB 单文件，导入 ~400ms（FUSE 盘）。可选：`esbuild --minify`（约 -30% 体积）；robotics/campaign 子系统懒加载意义不大（已在同一 bundle 内，解析成本一次性）。低优先级。
- 每回合 `_upsertIndex` 现在带文件锁（本日 M-2 修复引入）：3 次 fs 操作/回合，<1ms，无需处理；列出仅供知悉。
- web_fetch 15min/50 条缓存、CampaignStateStore 增量 JSONL 读取、SubAgent 通知队列——均已是合理设计。

## 已经做对的（明确保持，不要"优化"掉）

1. **DeepSeek KV 前缀缓存保护**：stable system prompt 字节级去重（MetaAgentSession.ts:274）+ 易变上下文移入 user 消息前缀。这是对 API 延迟/成本影响最大的设计，已正确实现——任何把每回合变化内容写回 system prompt 的"重构"都会造成数量级的退化。
2. Anthropic SDK 客户端按 (key, baseURL, betas) 池化复用（H7），keep-alive 跨回合生效。
3. S3 消息数组零拷贝（state.messages 与 mutableMessages 共享引用）。
4. 会话持久化增量 append（只序列化新消息）；标题生成、经验提取均已移出关键路径（后台 void async）。
5. CLI 渲染：流式 sanitizer + stdout 背压感知（safeStdoutWrite + drain）。

## 建议实施顺序

| 优先级 | 项目 | 预期收益 | 改动量 |
|---|---|---|---|
| 1 | P0-1 flash 侧调用并行化 | 首 token −0.3~1.5s | 小（~20 行） |
| 2 | P0-2 内存召回降超时/跳过/缓存 | 每回合 −0.2~1.5s | 小 |
| 3 | P1-1 git 分支状态微缓存 | robotics 每回合 −20~80ms×N | 小 |
| 4 | P2-1 startDelay 250→50ms | 子代理扇出 −0.6s | 1 行 |
| 5 | P1-3 instrumentTool parse/落盘瘦身 | 工程模式每工具调用 −1~10ms + 写放大减半 | 中 |
| 6 | P1-2 / P2-2 | 微小 | 小 |
