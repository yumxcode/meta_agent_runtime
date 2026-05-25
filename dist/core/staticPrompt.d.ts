/**
 * Meta-Agent 静态系统提示词 — S1 至 S6
 *
 * 这些节在同一部署周期内保持不变，构成"全局"缓存区：
 * SYSTEM_PROMPT_DYNAMIC_BOUNDARY 之前的内容在所有会话中稳定，
 * 可在 Anthropic 提示词缓存层进行缓存。
 *
 * 节映射（与 meta-agent-architecture.md §4.1 静态区一致）：
 *   S1  identity_definition        — Meta-Agent 的身份与职责
 *   S2  system_rules               — 溯源 ID、会话作用域、运行规则
 *   S3  task_execution_rules       — 执行纪律、工程专用规则
 *   S4  tool_invocation_protocol   — 工具调用规则、溯源工具、V&V 响应
 *   S5  action_risk_rules          — 不可逆操作、磁盘持久化风险
 *   S6  style_rules                — 报告与对话的输出格式
 *
 * 已迁移至动态区（按模式条件注入）：
 *   D4a engineering_standards      — 工程计算规范（agentic/campaign 模式）
 *   D4b campaign_knowledge         — DOE/campaign 领域知识（mode === 'campaign'）
 */
export declare const DEFAULT_SUB_AGENT_SYSTEM_PROMPT = "\u4F60\u662F Meta-Agent \u5B50\u667A\u80FD\u4F53\u3002\u4F7F\u7528\u53EF\u7528\u5DE5\u5177\u5B8C\u6574\u6267\u884C\u6307\u5B9A\u4EFB\u52A1\u2014\u2014\u4E0D\u8981\u8FC7\u5EA6\u5EF6\u4F38\uFF0C\u4E5F\u4E0D\u8981\u534A\u9014\u800C\u5E9F\u3002\u5B8C\u6210\u540E\uFF0C\u5411\u7236\u667A\u80FD\u4F53\u62A5\u544A\u5DF2\u5B8C\u6210\u7684\u5185\u5BB9\u548C\u5173\u952E\u53D1\u73B0\uFF1B\u7236\u667A\u80FD\u4F53\u4F1A\u5C06\u7ED3\u679C\u8F6C\u8FF0\u7ED9\u7528\u6237\u3002\n\n\u91CD\u8981\uFF1A\u4E25\u7981\u7ED5\u8FC7 V&V \u9A8C\u8BC1\u5668\u6216\u4FEE\u6539\u6EAF\u6E90\u8BB0\u5F55\u3002\u82E5\u65E0\u6CD5\u5B8C\u6210\u4EFB\u52A1\uFF0C\u8BF7\u660E\u786E\u62A5\u544A\u963B\u585E\u539F\u56E0\uFF0C\u800C\u975E\u8FD4\u56DE\u65E0\u58F0\u660E\u7684\u90E8\u5206\u7ED3\u679C\u3002";
/**
 * 分隔静态（全局可缓存）提示词区与动态（每会话）区的标记字符串。
 *
 * 置于静态系统提示词字符串末尾，供提示词缓存基础设施识别缓存边界。
 */
export declare const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "\n\n<!-- SYSTEM_PROMPT_DYNAMIC_BOUNDARY -->\n\n";
/**
 * 构建静态系统提示词（S1–S3、S5–S6）。
 *
 * 节映射：
 *   S1  identity_definition
 *   S2  system_rules
 *   S3  task_execution_rules
 *   S5  action_risk_rules
 *   S6  style_rules
 *
 * 已迁移至动态区（按模式条件注入）：
 *   D4a engineering_standards      ← agentic/campaign 模式
 *   D4b campaign_knowledge         ← mode === 'campaign'
 *   D4c tool_invocation_protocol   ← 按 mode 裁剪：robotics 无 V&V，campaign 含完整溯源+V&V
 *
 * 返回的字符串在同一部署周期内对所有会话保持稳定。
 * 未来将以 `cache_control: ephemeral` 发送，以利用 Anthropic 提示词缓存（P2-A）。
 */
export declare function buildStaticSystemPrompt(): string;
//# sourceMappingURL=staticPrompt.d.ts.map