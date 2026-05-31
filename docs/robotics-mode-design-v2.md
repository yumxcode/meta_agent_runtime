# Robotics Mode 增量设计 v2 — 已归档

> **状态：📦 归档**  
> 本文档覆盖 SessionRouter 扩展、会话持久化、Git 分支协同三个议题的增量设计。  
> 三者均已实现，当前 as-built 参考：[meta-agent-architecture.md](architecture/meta-agent-architecture.md) §6.4

---

## 设计 vs 实现的主要差异

### 1. SessionRouter / ModeDetector

v2 设计的 `ROBOTICS_ALWAYS`（Tier 0 正则）、LLM prompt 扩展、`detectSync` 流程均已按设计实现。  
`MODE_WEIGHT['robotics'] = 3`（最高优先级）已落地。

**差异：`SessionRouter._createImpl` 接口变更**  
v2 设计中 `_createImpl('robotics')` 直接返回 `RoboticsSession`，实际实现中  
`RoboticsSession` 不实现 `SessionImpl` 接口，而是通过 `AgenticSession`（组合）暴露接口，  
`SessionRouter` 内部的路由逻辑有所不同。

### 2. 会话持久化（RoboticsProjectStore）

设计与实现基本吻合，主要差异：

| v2 设计 | 实际实现 |
|--------|---------|
| 无星标/tag 字段 | `starred?: boolean`、`tags?: string[]` 新增 |
| 无自动清理 | `purgeStale()`：7 天非星标会话自动删除 |
| 恢复窗口 30 天 | 保持不变 |
| `conversation.jsonl` 可选消息历史 | **未实现**（不必要） |

`RoboticsProjectStore` 现在提供 `listAll()` / `star()` / `setTags()` / `purgeStale()` 四个会话管理方法，  
并对应注册了三个 Agent 工具（`session_list`、`session_star`、`session_tag`）。

### 3. Git 分支协同（GitWorkspaceManager）

设计与实现高度吻合：
- `createWorktreeForTask()` / `syncMainToTask()` / `mergeTaskBranch()` / `removeWorktree()` 均已实现
- 四个 git 工具（`git_sync_to_subagent`、`git_merge_subagent`、`git_diff_subagent`、`git_discard_subagent`）已注册

**差异：**  
v2 设计中 `reconcileWorktrees()` 在 init 时重建丢失的 worktree；  
实际实现中，stale sub-agent task 通过 `purgeStaleSubAgentTask()` 清除，worktree 不自动重建。

### 4. R3 节（活跃子 Agent 展示）

v2 设计的 R3 包含 git branch status 表格（`±commits`、`last commit`）。  
实际实现中 R3 展示的信息更精简：任务 ID、角色、标题、状态、分支名，  
无 last-commit-message 列（减少 prompt 体积）。

---

## 设计决策复盘

| 决策点 | v2 选择 | 最终状态 |
|--------|--------|---------|
| 会话 key | `projectDir` (cwd) | ✓ 实现 |
| 恢复窗口 | 30 天 | ✓ 保持 |
| git worktree 方案 | worktree（非 clone） | ✓ 实现 |
| squash 合并默认值 | squash | ✓ 实现 |
| 失败实验代码处理 | discard + 保留经验 | ✓ 实现 |
| 星标 / 7 天清理 | ✗ 未设计 | 新增实现 |

---

*文档状态：归档。不再更新。如需了解当前实现，请查阅 `docs/architecture/meta-agent-architecture.md`。*
