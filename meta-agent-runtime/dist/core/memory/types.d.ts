/**
 * Meta-Agent Memory — 类型分类与提示词文本块
 *
 * 五种记忆类型（对比 CC 的四种）：
 *   user             — 与 CC 一致
 *   feedback         — 与 CC 一致
 *   domain_knowledge — 替换 CC 的 reference，用于已验证的工程事实
 *   campaign_lessons — 新增：从已完成 DOE campaign 中提炼的可迁移经验
 *   reference        — 外部系统指针（与 CC 的 reference 类似，范围更窄）
 *
 * 三条工程专用硬边界（CC 中没有）：
 *   仿真结果          → ProvenanceTracker
 *   活跃 campaign 状态 → D8 campaign_context（实时）
 *   项目参数          → Campaign 配置文件
 */
export declare const MEMORY_TYPES: readonly ["user", "feedback", "domain_knowledge", "campaign_lessons", "reference"];
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