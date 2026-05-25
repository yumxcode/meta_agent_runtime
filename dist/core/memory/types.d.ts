/**
 * Meta-Agent Memory — 类型分类与提示词文本块
 *
 * 六种记忆类型（对比 CC 的四种）：
 *   user             — 与 CC 一致
 *   feedback         — 与 CC 一致
 *   domain_knowledge — 替换 CC 的 reference，用于已验证的工程事实
 *   campaign_lessons — 新增：从已完成 DOE campaign 中提炼的可迁移经验
 *   robot_lessons    — 新增：robotics mode 中可迁移的错误、警告、避坑经验
 *   reference        — 外部系统指针（与 CC 的 reference 类似，范围更窄）
 *
 * Mode-specific hard boundaries:
 *   campaign: 仿真结果 → ProvenanceTracker；活跃状态 → campaign_context；参数 → Campaign 配置
 *   robotics: 成熟工程经验 → ExperienceStore；memory 只记录公共偏好、警告和错误模式
 */
export declare const MEMORY_TYPES: readonly ["user", "feedback", "domain_knowledge", "campaign_lessons", "robot_lessons", "reference"];
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