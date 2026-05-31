# Robotics Mode 设计草稿 v1 — 已归档

> **状态：📦 归档**  
> 本文档是 robotics mode 的早期设计方案（v1），已按实际情况落地实现。  
> 当前实现的完整参考请查阅：
> - [meta-agent-architecture.md](architecture/meta-agent-architecture.md) — 整体架构 as-built 参考（§6 Robotics Mode）
> - [robotics-mode-design-v2.md](./robotics-mode-design-v2.md) — 持久化与 Git 协同设计（同样已归档，见下方变更说明）

---

## 设计 vs 实现的主要差异

以下记录 v1 设计与最终实现的显著差异，供历史参考：

### 1. 工具集规模

| v1 设计 | 实际实现 |
|--------|---------|
| 7 个工具 | 15 个工具 |
| 无 git 工具 | 4 个 git 协同工具（git_sync、merge、diff、discard） |
| 无进度工具 | progress_note（结构化进度笔记） |
| 无会话管理 | 3 个会话管理工具（session_list、star、tag） |

### 2. ExperiencePendingStore（v1 未设计）

实现中新增了 `ExperiencePendingStore`——一个会话级的待审经验缓冲区。  
经验写入不再直接提交到共享 store，而是先进入 pending 队列，等待用户通过 `/experience review` 确认后才持久化。  
这避免了低质量经验污染知识库。

### 3. 提示词装载方式（v1 设计有误）

v1 描述的 R1-R5 节通过 `sectionRegistry.register()` 直接挂载的方式**未实现**。  
实际通过 `modeExtensions` 扩展点（`DynamicSectionOptions.modeExtensions`）注入，保持 `core/` 对 `robotics/` 的依赖单向性。

### 4. D1a、D4a 已移除

v1 设计在 prompt 中保留了 D1a（memory_guidance）和 D4a（engineering_standards）。  
实际实现中这两节均已移除：
- D1a：memory 写入由 post-session 子 agent 负责，主 agent 只读（D1b）
- D4a：robotics 阶段不需要工程规范

### 5. 部分"开放问题"的决策结果

| 问题 | 决策 |
|------|------|
| 经验检索质量（双语） | 实现了关键词 + tag + domain 过滤，未引入向量嵌入 |
| EXPERIENCE_INDEX 大小控制 | 当前无分页，截断策略在 ExperienceStore 内实现 |
| 多机器人隔离 | 通过 `robot` 字段过滤，无物理隔离 |

---

*文档状态：归档。不再更新。如需了解当前实现，请查阅 `docs/architecture/meta-agent-architecture.md`。*
