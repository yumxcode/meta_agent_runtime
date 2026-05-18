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

export const MEMORY_TYPES = [
  'user',
  'feedback',
  'domain_knowledge',
  'campaign_lessons',
  'reference',
] as const

export type MemoryType = (typeof MEMORY_TYPES)[number]

// ─────────────────────────────────────────────────────────────────────────────
// 前言格式
// ─────────────────────────────────────────────────────────────────────────────

export const MEMORY_FRONTMATTER_EXAMPLE: readonly string[] = [
  '```markdown',
  '---',
  'name: {{记忆名称 — 具体且可搜索}}',
  'description: {{单行摘要，用于相关性匹配 — 尽量具体}}',
  `type: {{${MEMORY_TYPES.join(' | ')}}}`,
  'date: {{YYYY-MM-DD — 写入或最后核实的日期}}',
  '# domain_knowledge 类型需补充：  source: {{标准/教材/数据手册引用}}',
  '# campaign_lessons 类型需补充：  campaign: {{campaign ID 或项目名}}',
  '#',
  '# ── 可选防漂移字段（推荐用于 domain_knowledge 和 campaign_lessons）──',
  '# scope: {{global | project | campaign | domain}}  # 适用范围；campaign/project 范围的记忆在其他上下文中会被过滤',
  '# domain: {{engineering | battery | thermal | ...}} # 工程领域标签，用于跨领域召回过滤',
  '# valid_until: {{YYYY-MM-DD}}                      # 过期后自动排除召回（如：标准修订日、数据手册版本）',
  '# confidence: {{high | medium | low}}              # 对该事实的置信度；low 项将在提示词中标记',
  '# source_verified: {{true | false}}                # 是否经过一次源头核实（非转述）',
  '# requires_revalidation: {{true | false}}          # 标记需要在使用前重新核实的记忆',
  '---',
  '',
  '{{记忆内容}}',
  '',
  '# 推荐正文结构（feedback / domain_knowledge / campaign_lessons）：',
  '# **规则/事实：** 核心陈述',
  '# **原因：** 证据、事件或来源',
  '# **适用范围：** 何时何处适用；适用条件的注意事项',
  '```',
]

// ─────────────────────────────────────────────────────────────────────────────
// 类型说明节
// ─────────────────────────────────────────────────────────────────────────────

export const TYPES_SECTION: readonly string[] = [
  '## 记忆类型',
  '',
  '仅存储最匹配的类型：',
  '',
  '<types>',

  // ── user ──────────────────────────────────────────────────────────────────
  '<type>',
  '  <name>user</name>',
  '  <description>用户的角色、领域专长、背景，以及偏好的协作方式。用于校准技术深度和沟通风格。</description>',
  '  <when_to_save>当了解到用户角色、领域背景或协作偏好的详情时保存。</when_to_save>',
  '  <examples>',
  "    user: 我是专注于电动汽车电池热管理的机械工程师。",
  '    → [保存 user 记忆：机械工程师，专攻 EV 电池热管理——以 MechE 研究生水平校准解释]',
  '  </examples>',
  '</type>',

  // ── feedback ──────────────────────────────────────────────────────────────
  '<type>',
  '  <name>feedback</name>',
  '  <description>用户对工作方式的指导——包括要避免的和要保持的。纠正与确认都要记录：只存纠正会避开过去的错误，但会偏离用户已验证的方法，并可能变得过度谨慎。</description>',
  '  <when_to_save>任何时候用户纠正了你的方法，或明确确认了某个非显然的选择有效时。包含原因，以便日后判断边界情况。</when_to_save>',
  '  <body_structure>**规则：** 核心陈述。**原因：** 用户给出的理由——通常是过往事件或强烈偏好。**适用范围：** 该规则何时生效及注意事项。</body_structure>',
  '  <examples>',
  "    user: 不要在没有我明确批准的情况下启动 L1 升级——我需要控制高保真预算。",
  '    → [保存 feedback 记忆：即使超过 hypervolume 阈值，也须获得用户明确批准才能启动 L1/L2 升级。原因：用户掌控高保真计算预算。]',
  '',
  '    user: 是的，这里选 50 点 LHC 是正确的。',
  '    → [保存 feedback 记忆：对于该用户，50 点 LHC 是热力学问题的首选初始采样规模。已确认方法，非纠正。]',
  '  </examples>',
  '</type>',

  // ── domain_knowledge ──────────────────────────────────────────────────────
  '<type>',
  '  <name>domain_knowledge</name>',
  '  <description>已验证的物理常数、材料属性、工程标准或领域规则——须稳定且跨项目适用。必须注明来源和日期。严禁存储具体仿真结果——那些应通过 provenance tracker 以 prov-xxx ID 存储。</description>',
  '  <when_to_save>当遇到（a）适用于多个未来项目、（b）无法从当前项目文件推导、（c）能引用来源的领域事实时保存。</when_to_save>',
  '  <body_structure>**事实：** 带单位和有效范围的数值。**来源：** 标准/教材/数据手册 + 日期。**适用范围：** 何时使用及已知局限性。</body_structure>',
  '  <examples>',
  "    user: SS316 的热导率根据供应商数据手册为 16 W/(m·K)。",
  '    → [保存 domain_knowledge 记忆：SS316 热导率 = 16.3 W/(m·K)（20 °C）。来源：供应商数据手册 rev 3.2（2025-09）。有效范围 20–200 °C；500 °C 时降约 8%。]',
  '  </examples>',
  '</type>',

  // ── campaign_lessons ──────────────────────────────────────────────────────
  '<type>',
  '  <name>campaign_lessons</name>',
  '  <description>从已完成 DOE campaign 中提炼的可迁移经验。不是当前 campaign 状态（那在 campaign_context 中）。这些是可应用于同类未来 campaign 的总结——代理模型不准确、阈值校准、有效或失败的升级决策。</description>',
  '  <when_to_save>campaign 进入 REPORTING 阶段后保存。记录超出预期的发现、有效的阈值、L0 代理模型的不准确之处，以及用户批准或拒绝的内容。只保存可泛化的规律，不保存一次性观察。</when_to_save>',
  '  <body_structure>**经验：** 可泛化的规律。**证据：** 哪个 campaign、什么数据、量级。**适用范围：** 适用条件和注意事项。</body_structure>',
  '  <examples>',
  '    [完成电池热管理 campaign camp-abc123 后：]',
  '    → [保存 campaign_lessons 记忆：锂离子电池热力学问题——L0→L1 升级阈值应为 hypervolume ≥ 0.85（非默认 0.73）。证据：camp-abc123 中 0.73 触发了过早升级；L1 Pareto 前沿差异 22%。适用范围：任何电池热管理 campaign。注意：固态电解质体系可能不适用。]',
  '  </examples>',
  '</type>',

  // ── reference ─────────────────────────────────────────────────────────────
  '<type>',
  '  <name>reference</name>',
  '  <description>外部资源指针：仿真工具 API 端点、材料数据库、内部仪表盘、文档 URL。记录"去哪里找"——而非内容本身。</description>',
  '  <when_to_save>了解到外部资源及其用途时保存。</when_to_save>',
  '  <examples>',
  '    user: 内部材料数据库在 materials.internal/api/v2，用于合金查询。',
  '    → [保存 reference 记忆：内部材料数据库位于 materials.internal/api/v2——用于合金属性查询]',
  '  </examples>',
  '</type>',

  '</types>',
  '',
]

// ─────────────────────────────────────────────────────────────────────────────
// 不应存入记忆的内容 — 三条工程硬边界
// ─────────────────────────────────────────────────────────────────────────────

export const WHAT_NOT_TO_SAVE_SECTION: readonly string[] = [
  '## 不应存入记忆的内容',
  '',
  '**三条硬边界——这些有专用系统，不得绕过：**',
  '',
  '1. **仿真/计算结果**（特定输入→特定输出）',
  '   使用 **provenance tracker**（`find_duplicate_computation`、`get_provenance`）。记忆没有输入参数、',
  '   没有可溯性、没有 prov-xxx ID——存在记忆中的结果无法审计或复用。',
  '',
  '2. **活跃 campaign 状态**（当前阶段、实时 Pareto 前沿、运行中的 job ID）',
  '   **campaign_context 节（D8）** 每轮从实时磁盘状态自动注入。',
  '   将过期 campaign 状态存入记忆会与实时上下文产生矛盾。',
  '',
  '3. **项目专属参数**（设计变量范围、目标定义、仿真配置）',
  '   这些属于 **campaign 配置文件**，是权威来源。',
  '   存入记忆会在配置更新时造成漂移。',
  '',
  '同样不应存储：',
  '- 临时会话上下文或对话摘要',
  '- 调试步骤或一次性修复（修复已在代码中；commit 消息有上下文）',
  '- 未经验证的数值——若无法引用原始来源，不得存为 domain_knowledge',
  '- 已在 CLAUDE.md 或项目文档中记录的内容',
  '',
]

// ─────────────────────────────────────────────────────────────────────────────
// 如何保存记忆 — 两步操作（与 CC 一致）
// ─────────────────────────────────────────────────────────────────────────────

export const HOW_TO_SAVE_SECTION: readonly string[] = [
  '## 如何保存记忆',
  '',
  '保存记忆是两步操作：',
  '',
  '**第一步** — 将记忆写入记忆目录中的独立文件',
  '（例如 `user_role.md`、`battery_escalation_threshold.md`）：',
  '',
  ...MEMORY_FRONTMATTER_EXAMPLE,
  '',
  '**第二步** — 在 `MEMORY.md` 中添加一行指针：',
  '```',
  '- [记忆名称](filename.md) — 单行钩子，描述该文件包含的内容',
  '```',
  '',
  '`MEMORY.md` 是索引，不是内容存储——每条目应为一行，不超过约 150 个字符。',
  '不得将记忆内容直接写入 `MEMORY.md`。',
  '',
  '创建新文件前：先扫描 `MEMORY.md`，确认是否有可更新的现有条目。',
  '',
]

// ─────────────────────────────────────────────────────────────────────────────
// 何时访问记忆（含 "ignore" 处理，对齐 CC）
// ─────────────────────────────────────────────────────────────────────────────

export const WHEN_TO_ACCESS_SECTION: readonly string[] = [
  '## 何时访问记忆',
  '',
  '- **campaign 开始前**：选择 DOE 策略前，先检查相关的 campaign_lessons 和 domain_knowledge。',
  '- **需要材料/物理常数**：查询外部工具前，先检查 domain_knowledge。',
  '- **用户询问过往方法**：检查 feedback 和 user 记忆。',
  '- **用户明确要求召回或记住某事**：立即执行。',
  '- **用户要求忽略或遗忘某条记忆**：在本次会话剩余时间内，将 MEMORY.md 视为不含该事实。不得应用、引用、与记忆内容对比，或提及该记忆。',
  '',
]

// ─────────────────────────────────────────────────────────────────────────────
// 引用记忆前先验证（对齐 CC 的 TRUSTING_RECALL_SECTION，工程化适配）
// ─────────────────────────────────────────────────────────────────────────────

export const TRUSTING_RECALL_SECTION: readonly string[] = [
  '## 引用记忆前先验证',
  '',
  '记忆中出现的具体文件路径、函数名或工具端点，记录的是写入时刻的状态——不代表现在仍然有效。',
  '',
  '- 记忆引用了文件路径：先确认文件存在。',
  '- 记忆引用了函数或常量：先用 Grep 工具确认。',
  '- 记忆中的数值（domain_knowledge）：引用前核对来源；若无法核实，在分析中明确注明"来自记忆，未核实"。',
  '- 用户即将基于你的建议行动（而非仅询问历史）：先验证，再推荐。',
  '',
  '"记忆中说 X 存在" ≠ "X 现在仍然存在"。',
  'campaign_lessons 的阈值是从特定物理场景提炼的——跨领域迁移前，先检查物理相似性。',
  '',
]

// ─────────────────────────────────────────────────────────────────────────────
// 工程记忆漂移警告（比 CC 更强）
// ─────────────────────────────────────────────────────────────────────────────

export const DRIFT_CAVEAT: readonly string[] = [
  '## 工程记忆漂移——行动前先验证',
  '',
  '工程记忆可能已过期或受上下文限制：',
  '',
  '- **数值（domain_knowledge）**：在计算中使用前，先核对所引用的来源。',
  '  若无法核实，在分析中明确注明"来自记忆，未核实"。',
  '- **campaign_lessons 阈值**：仅适用于物理场景和保真度结构相似的问题。',
  '  不得在不同工程领域之间盲目迁移阈值。',
  '- **reference 指针**：引用前先确认资源仍可访问。',
  '',
  '工程领域中过期的数值记忆不只是错误——它会通过溯源记录传播，可能损坏整个 Pareto 前沿。',
  '当数值至关重要时，先验证，再使用。',
  '',
]

// ─────────────────────────────────────────────────────────────────────────────
// 作用域与新鲜度元数据说明
// ─────────────────────────────────────────────────────────────────────────────

export const SCOPE_FRESHNESS_SECTION: readonly string[] = [
  '## 记忆作用域与新鲜度',
  '',
  '每条记忆文件可声明可选的防漂移元数据字段（在 frontmatter 中）：',
  '',
  '- **scope**（`global | project | campaign | domain`）',
  '  - `global`：适用于所有会话（默认）。',
  '  - `project`：仅适用于特定项目——在其他项目中不会被召回。',
  '    ⚠ 项目标识符必须写在 `campaign:` frontmatter 字段中（不是 `domain:` 字段）。',
  '    示例：`scope: project` + `campaign: proj-battery-2026`',
  '  - `campaign`：仅适用于特定 campaign（配合 `campaign` 字段使用）。',
  '  - `domain`：仅适用于特定工程领域（配合 `domain` 字段使用）。',
  '',
  '- **valid_until**（YYYY-MM-DD）',
  '  过期后该记忆不会被自动召回。适用于有已知修订日期的标准、数据手册版本等。',
  '',
  '- **confidence**（`high | medium | low`）',
  '  召回时，`low` 置信度的记忆在上下文中会被标记，提醒你在使用前重新核实。',
  '',
  '- **source_verified**（`true | false`）',
  '  该事实是否经过原始来源核实（非转述）。未经核实的数值须注明。',
  '',
  '- **requires_revalidation**（`true | false`）',
  '  标记需要在使用前重新核实的记忆（如：已知条件变更、数值被质疑等）。',
  '',
  '**重要：** 系统会自动过滤掉 `valid_until` 已过期的记忆；',
  '`scope` 字段可在长任务中排除跨项目或跨 campaign 的不相关记忆，防止旧上下文污染当前推理。',
  '',
]
