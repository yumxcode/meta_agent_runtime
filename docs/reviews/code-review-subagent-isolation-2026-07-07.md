# SubAgent 与隔离机制全面审核 + 性能优化方案 — 2026-07-07

**审核范围**：SubAgentBridge（调度/预算/通知/重试）、SubAgentRunner（生命周期/终态/checkpoint）、SubAgentTaskStore、sandbox 执行器（bwrap / sandbox-exec / noop）、AutoWorktreeCoordinator（isolated_write 生命周期）、JudgeSnapshot、派发工具（run_agent / spawn_sub_agent / experiment_dispatch / paper_search / research_dispatch）。

**验证**：`src/subagent` + `src/sandbox` 7 文件 38 用例通过（此前 core/auto、kernel、robotics 套件亦全绿）。

---

## 1. 隔离机制审核结论

隔离是四层叠加，逐层审读后**未发现可利用的隔离漏洞**：

| 层 | 机制 | 强制方式 |
|---|---|---|
| 上下文 | 全新 MetaAgentSession、空历史、精简 system prompt | 构造隔离 |
| 权限 | 子 Agent 自带 PermissionPolicy；auto jail 经 `setAutonomyJail` 继承（fail-closed sandbox、projectDir 绑定 jail 根） | 策略层 |
| OS | `shared_readonly` → sandbox `readonlyWorkspace + writeAllowPaths:[] + allowUnsandboxedFallback:false` **且**写类工具从 allowedTools 里过滤；嵌套 bwrap fail-closed | 内核层 |
| Git | `isolated_write` → 独立 worktree+branch，`.meta-agent/` 双重防丢（sandbox deny + 工具层 guard 报错指引），finalize/merge 走 stash 事务 + 回滚 + 启动 reconcile | 版本层 |

值得肯定的细节：verify judge 在活树上主动降级掉 bash（唯一写向量）；显式 isolated_write 请求在 worktree 不可用时 fail-closed 而非静默降级；取消/完成的终态写通过 per-task 写链原子化（L1 修复）；通知溢出合并而非丢弃。

### 隔离面发现

**I-1（中）｜D1b 记忆召回注入每个子 Agent，既是隔离渗漏也是首因延迟**
子 Agent 的 MetaAgentSession 走标准 `_submitInner`，每次 submit 构建 volatile 段时无条件执行 D1b 记忆召回——用户全局记忆被注入到**所有**子 Agent（包括 verify judge / drift 审查者，它们的设计声明是"独立上下文"）。隔离上这是温和渗漏（是用户记忆而非执行者叙事），但性能上是硬成本（见 P-1）。

**I-2（低）｜非 auto 模式子 Agent 默认无 OS sandbox**
`cfg.sandbox` 未设时（robotics experiment 等）只有权限策略路径检查 + 敏感命令识别兜底。属刻意设计（实验 Agent 需要真实环境），建议在文档里明示这个姿态差异。

---

## 2. 正确性发现

**C-1（P2）｜自动重试不区分确定性失败**
`_maybeRetryFailed` 用**完全相同的 config** 重试（`shouldRetrySubAgentConfig` 收了 config 参数但忽略它）。`error_max_turns` / `Budget exceeded` 是确定性失败——同配置重跑必然再次失败，auto 模式默认重试 2 次等于**白烧 2 遍完整子 Agent 的钱和时间**（还叠加 1s/2s 退避）。这是正确性和性能的双重问题。**建议**：终态 error 匹配 max_turns/budget 时不重试（或重试时放宽对应上限）。

**C-2（P3）｜`lastText` 无界累积**
Runner 把所有 text 事件拼进 `lastText`，长任务可达 MB 级；每次 checkpoint 都对全量文本跑 progressState 正则。建议环形保留（如尾部 64KB + 最后一个 ```json 块）。

**C-3（P3）｜注释漂移**
`findRelevantMemories` 注释写 "Default 3 s"，常量是 `DEFAULT_RECALL_TIMEOUT_MS = 30_000`。30s 作为**每个子 Agent 都要过的前置侧调**的最坏等待过大（见 P-1）。

---

## 3. 性能分析：慢在哪里

一个子 Agent 从派发到结果的延迟构成（估算）：

```
spawnSubAgent 写盘+调度      ~10-60ms   （startDelay 50ms 仅多任务时）
Runner 启动 + session 构建    ~10-50ms
D1b 记忆召回 flash 侧调       1-5s，最坏 30s  ← 非 LLM 部分的最大头
子 Agent LLM 轮次 (5-30 turn) 数十秒-数分钟   ← 本质主导
完成检测（轮询 0.5-2s 间隔）   平均 +0.25-1s
isolated_write finalize      每次 getStatus 都重跑 3-5 个 git 子进程 ← 可省
```

LLM 轮次本身不可压缩，但以下部分可以：

### P-1（最高优先）｜子 Agent 跳过 D1b 记忆召回
每个子 Agent（含 judge/drift/research）启动前都做一次 flash 相关性侧调 + 记忆目录读取。子 Agent 拿到的是完整 taskDescription，不需要全局记忆；judge 更是明确要求独立。**方案**：`SubAgentRunner` 的 sessionConfig 加 `skipMemoryRecall`（或复用 `externalPromptAssembly` 的思路给 D1b 加开关），MetaAgentSession 构建 volatile 段时据此不传 client。收益：每个子 Agent 省 1-5s（最坏 30s），fan-out 场景按并发数放大；同时收紧 judge 独立性。

### P-2｜finalize 幂等早退
`_finalizeUnlocked` 对已 `awaiting_merge`/`merged` 且有 `finalizedCommit` 的记录没有早退：主 Agent 每次 `get_sub_agent_status` 已完成的 isolated_write 任务都会重跑 git status/rev-list/rev-parse + 两次注册表写，且全部串行在 coordinator 互斥锁上（会阻塞并发的 merge/diff）。**方案**：phase 已终态时直接返回缓存结果，一行早退。

### P-3｜完成检测从轮询改为事件等待
run_agent（500ms）、experiment_dispatch / paper_search / research_dispatch（2s）都是磁盘轮询 `readTask`。同进程内 runner 完成时本来就发 CampaignEventBus 事件、且 `runner.wait()` 可直接 await。**方案**：Bridge 暴露 `waitForTerminal(taskId, {timeoutMs})`——优先 `runner.wait()`/事件，轮询仅作跨进程兜底。收益：每个同步等待的任务省平均 0.25-1s 尾延迟 + 消除周期性磁盘 IO；串行链（paper_search → 实验 → 合并）按环节数累加。

### P-4｜确定性失败不重试（同 C-1）
auto 模式下一个 max_turns 失败的任务当前实际耗时 ≈ 3 倍单次时长 + 3s 退避。修掉后失败路径直接快 ~3×。

### P-5｜并发与默认预算调优
- 并发上限默认 4（auto 3）是 fan-out 吞吐的硬顶；对 shared_readonly 的研究型任务本地开销极小，真正的约束是 provider 限流。建议：读类任务用独立的更高上限（或至少在文档/R1 提示里指出 `META_AGENT_MAX_CONCURRENT_SUB_AGENTS`）。
- `DEFAULT_SUB_AGENT_CONFIG` 的 maxTurns:10 / $0.5 偏小：靠默认值派发的任务容易撞 max_turns 失败（再叠加 C-1 的无效重试）。建议 spawn_sub_agent 工具描述里引导按任务规模显式设置，或把默认提到 20/$1。

### P-6（微小，可不做）
- start delay 50ms 已是优化后的值，无需动。
- bwrap 每命令一次进程包装，开销 ~10ms 级，可忽略。
- checkpoint 每 3 轮全量写记录（含 ≤12KB 文本），IO 可忽略。

### 预期总收益
非 LLM 开销从「每任务 1.5-6s（最坏 30s+）+ 失败 3×」降到「<0.3s + 失败 1×」。对典型的"派发 3 个研究子 Agent + 串行等待"场景，端到端约省 5-20s；对含失败重试的 auto 长任务，节省可达分钟级与 2/3 的无效花费。LLM 轮次是剩余主导项——进一步提速只能靠减少子 Agent 轮数（更精确的 taskDescription、更小的 allowedTools 面）与提高并行度。

---

## 4. 建议实施顺序

1. **P-2 finalize 早退**（一行改动，零风险）。
2. **P-4/C-1 确定性失败不重试**（小改动，省钱省时）。
3. **P-1 子 Agent 跳过记忆召回**（中等改动：一个 config 开关 + MetaAgentSession 一处分支；顺带修 C-3 注释并把侧调默认超时降到 5s）。
4. **P-3 waitForTerminal**（中等改动，四个派发工具受益）。
5. **P-5 并发/预算默认值**（参数调整 + 文档）。
