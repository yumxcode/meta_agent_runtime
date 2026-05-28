/**
 * Meta-Agent Memory — 类型分类与提示词文本块
 *
 * 两种记忆类型（精简设计）：
 *   user     — 用户画像：角色、背景、沟通偏好
 *   feedback — 用户对 agent 行为的纠正与确认
 *
 * Hard boundaries（全模式适用）：
 *   - 成功/失败经验、算法陷阱、调参记录 → ExperienceStore（experience_write 工具）
 *   - 工程计算结果 → ProvenanceTracker（campaign 模式）或代码注释
 *   - 活跃状态、任务进度 → campaign_context / robotics R5 section（自动注入）
 *   - 领域知识、外部 API 指针 → 项目文档或 AGENT.md，不写入 memory
 *
 * 设计原则：memory 只存"关于用户"的信息，不存"关于世界"或"关于工程"的信息。
 * 工程经验由 ExperienceStore 统一管理，具备结构化检索和跨 session 复用能力。
 */
export declare const MEMORY_TYPES: readonly ["user", "feedback"];
export type MemoryType = (typeof MEMORY_TYPES)[number];
export declare const MEMORY_FRONTMATTER_EXAMPLE: readonly string[];
export declare const TYPES_SECTION: readonly string[];
export declare const WHAT_NOT_TO_SAVE_SECTION: readonly string[];
export declare const HOW_TO_SAVE_SECTION: readonly string[];
export declare const WHEN_TO_ACCESS_SECTION: readonly string[];
export declare const TRUSTING_RECALL_SECTION: readonly string[];
export declare const DRIFT_CAVEAT: readonly string[];
export declare const SCOPE_FRESHNESS_SECTION: readonly string[];
//# sourceMappingURL=types.d.ts.map