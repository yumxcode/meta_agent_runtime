# Meta-Agent Graph Loop 审查与优化报告

日期：2026-07-20（更新于 2026-07-21）  
范围：`src/loop/graph/**`、Graph runner/daemon/wake、Host Scheduler、Graph Agent 工作区隔离与 Distill 接口。

本轮结论是：durable-graph-v2 已经有一套不错的持久化执行骨架，串行循环、Agent 分段执行、相对定时、外部事件、Effect 轮询和 fan-out/join 都有对应机制；但当前版本还不能把“通过现有测试”视为“并发和故障语义可靠”。审查通过最小复现确认了符号链接越权、伪 serializable、随机 Terminal 仲裁、stop 终态被旧 activation 覆盖等问题。

优化不以继续扩充 Graph DSL 为目标。Graph 应只表达必须由 Kernel 确定执行的少量事实：持久状态、权限边界、等待点、确定性分支和终态。一个 Agent 节点应能在自然语言目标和 Lane 权限内自行规划、使用工具、检查结果并决定何时完成或定时续作。内部可靠性应来自事务、fencing、单调状态和持久 wake，而不是让 Distill 生成更多互相引用的结构化中间层。

## 已确认的问题

最严重的问题位于工作区写保护。Graph Lane 的 allow/deny 路径传给 SubAgent 后，进程内写工具只做词法路径判断。若允许目录内存在指向 `.loop`、`.git` 或其他 Lane 的符号链接，`write_file`/`edit_file` 可以越过 deny。该问题直接影响 Graph 控制面完整性，必须按目标路径的 canonical path 判断，且 deny 始终优先。

`stateConsistency: serializable` 的 stale check 与正式 commit 处于两个事务。两个 activation 可同时看到同一 State 版本并都成功提交，因此原语义只是“尽力在提交前检查”，不是 serializable。正确边界必须在 commit 事务内比较 activation 的 expected state version；冲突 activation 由同一事务释放为 replay，不能先检查再提交。

并发 Terminal 由 ready activation 的随机 UUID 决定先后，而先提交的 Terminal 会取消其他分支。相同图多次运行可随机得到 done 或 failed。Terminal 必须使用作者可见的稳定字段仲裁，并采用失败优先的保守规则。同样，实例进入 done/failed 后，任何旧 lease 或 prepared intent 都不得覆盖终态；operator stop、fatal failure 和 wall-time failure 都必须是单调的。

Graph ABI 的未知字段检查较严格，但必填字段和嵌套值类型并不严格。缺失顶层 `state`、拼错的 ShapeSpec 字段以及错误的 `additionalProperties` 类型都可通过前置验证，之后才在 Create 或运行期失败。ABI 入口应先做小型、递归的运行时形状校验，再做图语义校验；不需要引入另一套可执行 IR。

Join 只验证 `expects` 中的 transition ID 在全图存在，没有验证它确实是该 Join 的入边。错误图因此会永久等待。崩溃恢复 prepared commit 时又没有补发在线路径拥有的 Join resume 信号，也存在永久 park 窗口。Join 应校验精确入边、恢复时补发信号，并复用 NodeBase 的可选 `timeoutMs`，不新增一套超时结构。

`maxWallTimeMs` 仅在 tick 入口检查。无 timeout 的纯外部事件等待没有下一次 wake，因而墙钟上限不会自行触发。runner 必须为每个有 wall deadline 的非终态实例持久化一个实例级 deadline wake。

表达式验证允许 `$event` 和 `$effect`，但运行时上下文从未提供这两个根。为保持简单，本轮应删除这两个虚假根；事件和 Effect 的节点结果继续通过已有 `$output` 传递。

Host graph-tick admission lease 已提供 heartbeat API，但 runner 没有调用。长 tick 超过 TTL 后可能被另一个进程再次准入。runner 应像 activation lease 一样续租并在退出前排空 heartbeat。

Agent 定时续作本身是合理的：Agent 可以在一个厚节点内工作，并用 timer hard-park 暂停物理段。当前不足是 timer reason、checkpoint 和 `__resume` 没有明确注入下一段 prompt，过度依赖持久会话历史。恢复段应收到一个紧凑 `__resume_context`，但 Kernel 不应规定 Agent 的详细计划结构。

## 场景判断

有界串行循环和普通 Agent→Terminal 场景可用。相对 timer、event wait、early event、delivery ID 去重和 Effect 幂等收据具备良好基础。绝对日历/Cron 暂时不应被塞入新 DSL；对多数 Agent 自主规划场景，“计算下一次延迟并 hard-park”已经更简单、更通用。若未来确有跨时区日历需求，宜只增加一个持久 `wait.at` 能力，而不是引入完整编排语言。

并行状态更新在修复原子 expected-version 之前不可靠。fan-out/join 在精确入边校验和恢复补信号之前存在活性风险。人工 pause/resume 基本可用，但 stop 必须通过终态 fencing 加固。外部事件核心 inbox 可用，生产接入层仍需要自己负责鉴权、payload 上限和 delivery ID；Kernel 侧至少应拒绝非 JSON 或过大事件。

## 本轮修复原则与范围

本轮代码优化遵循四条约束：不增加新的节点类型；不增加第二套 Graph/Blueprint DSL；不要求 Agent 把开放工作过程压缩为细碎字段；不为了静态可证明性拆分厚 Agent。新增运行时信息只使用保留的 `__resume_context`，Join 超时复用已有 `NodeBase.timeoutMs`。

优先修复 canonical path、事务内 serializable replay、稳定 Terminal 仲裁、终态 fencing、严格 ABI/ShapeSpec、Join 拓扑与恢复、wall deadline wake、Host admission heartbeat和恢复上下文。随后用故障导向测试覆盖这些不变量。Function/Reducer 插件进一步隔离、日志压缩、事件保留策略、掉电级 fsync 和完整日历调度属于后续演进；它们不应阻塞当前内核正确性修复，也不应通过扩充 Distill 结构来解决。

验收标准不是 Graph 产物字段更多，而是同一输入和外部事件顺序得到同一结果；stop 后状态不可反转；crash/recover 不丢 Join/wall deadline；Agent 可在 Lane 内自主执行并可靠续作；非法图在 Create 前返回明确诊断。

## 实施结果

本轮已完成上述高优先级修复。写工具现在按最近已存在父目录解析 canonical target，symlink 从 allow 目录跳入 deny 目录会被拒绝。serializable 的 expected State version 在 commit 文件锁事务内校验，冲突结果在同一事务中释放成 replay；无 State update 的 transition 不再无意义递增 State version。Agent 冲突重放上限收紧为 5，普通节点保持 50。

Terminal 改为 failed → paused → done 的稳定保守仲裁，同级再按 node id、transition id 与语义 input 排序。实例进入 paused/done/failed 后旧 commit 被 fencing；failed/done 会取消全部活动 activation，pause 会把 running activation 无损释放为 replay。activation heartbeat 发现 operator fencing 后会中止仍在运行的 Agent 段，避免 stop 后继续消耗模型和工具时间。

ABI 入口补齐顶层必填字段、关键嵌套类型和数组元素类型；ShapeSpec 现在拒绝拼错字段、错误布尔/数组/数值边界和矛盾 required。封闭 outputSchema 的路由字段拼写可静态检查。`$event/$effect` 虚假表达式根已删除，事件和 Effect 结果沿用 `$output`。

Join `expects` 必须与真实入边一致，恢复 prepared commit 会补发 Join signal，且 Join 可直接使用已有 `timeoutMs`/`timeout` outcome。事件纯等待会获得独立 graph wall-deadline wake。Host graph-tick admission 会按协调器 TTL 续租。Function node 和锁内 transition evaluation 都有时间上限，避免插件无限占用 Graph 事务。

Agent 自主性方面，没有增加节点类型或计划 DSL。执行 prompt 明确 Agent 拥有 Activation 内部计划和调整权；timer continuation 会收到紧凑的 reason/checkpoint/signal。hard park 的结构要求由八个预算字段收敛为 `timerPolicy.maxDelayMs/maxParks` 两个必填保险丝，segment/lifetime budget 只在业务确有需要时覆盖。Distill 先独立验证最小 Graph，再补审阅元数据；示例 outputSchema 只保留真正参与路由的字段。

真实项目 `agibot_x1_train_oma/x1_loop.md` 又暴露了一个 Distill 闭环问题。来源明确规定“无新增发现或结果变差才累加 stale”，首版 Graph 却用 `is_result_better == false`，把“有新增发现且结果不变”也误判为 stale；Reviewer 已准确指出应使用候选中现成的三态 `trend`，同时给出三条 `precomputed-routing` lint，但旧流程把任何语义拒绝都立即退回 Architect，并在下一次 Compiler 调用中不携带上一版候选，于是连续三次重新生成同一个有损布尔路由。修复后，只有 `intent_constraints` 层失败才允许一次 Architect 重读；control/workspace/lane/capability/precondition 层失败都携带完整候选、Reviewer 原始诊断和 lint，在 Compiler 内局部重编译。这样没有增加 Graph DSL 或计划结构，也不会因修一个真值条件而推翻 Agent 可自主规划的其余拓扑。

新增回归测试覆盖 serializable 双提交、稳定 Terminal、stop fencing/Agent abort、symlink escape、严格 ABI/ShapeSpec、Join 拓扑与 timeout、event-only wall deadline、外部事件大小、Function timeout、Host admission heartbeat、Agent timer resume context，以及三态确定性路由的 Reviewer→Compiler 局部修复。实施后 TypeScript typecheck 和 CLI 构建通过；全量测试结果见下文最终验收。

Distill 本身也做了收敛，不是继续扩 DSL。Architect 只交接自然语言 Constraint Ledger 和简明 Blueprint；Compiler 生成小控制骨架，并通过 `graph_validate`/`graph_patch_validate` 对同一候选做局部修复；Reviewer 只做六层准入判断。语义拒绝不再无条件重跑 Architect，仅 `intent_constraints` 层的源合同缺失才允许一次上游重读；路由、workspace、owner、能力和前置条件问题都在 Compiler 原会话内修图。Compiler/Reviewer 有独立 wall timeout，语义修复、最后一轮可执行修复和已 Freeze 图的紧凑 envelope 恢复分别保留预算，避免 JSON 格式往返吃掉真正的语义修复机会。

宿主机械检查新增了三类实跑中最常见的拦截。第一，重复的 `from/on/when` 谓词会使后续分支永远被遮蔽，现在是 error。第二，prompt 声明写入的项目外路径、未被 Lane 覆盖的文件和没有 scm/owned 能力的 git 操作会被提前拒绝；路径提取按句子限定写动词，不再把后文的只读路径误报为写目标。第三，持久 Lane 内多 Agent 会产生 `same-lane-agent-split` 审查提示；不同 prompt、角色名、first-run 标记或 budget 不构成边界，只有真实的持久化、权限/并发、Kernel Wait/Event、故障隔离或终态边界才允许拆分。该项保持 warning + 语义核验，没有粗暴禁止合理的同 Lane 节点。

X1 的真实实跑证明了这个闭环。旧候选用 `is_result_better == false` 丢失了 `trend` 三态，把“有新 findings + unchanged”误分到 stale 累加区；新版使用原始 `new_findings_count` 与 `trend` 真值表，并以更新前 `stale_count >= 1/3` 等价表达更新后 `>= 2/4`。Reviewer 还在 Freeze 通过后拦下了 `bootstrap` 将创建 `state/task_spec.md` 但没有任何 Lane 授权的首轮必崩图；Compiler 最终只给 research Lane 增加该单文件的 `atomic_replace` 规则，没有扩大到整个 `state/`。六层语义审查随后全部通过，产物为 2 个 Lane、4 个执行 Agent 和 18 条确定性 Transition；常规研究仍是单个厚 `work` Agent，它在 Activation 内自主规划、训练、监控、分析与评估，Graph 仅接收路由必需的原始事实。

最后的人工产物核验又发现一个 ABI 空洞：`when` 对缺失可选字段会安全地视为不匹配，但 Transition target input 的 `$output.x` 是严格引用，缺失会在目标 Agent 启动前抛错。现在 success 边严格传递的输出字段必须出现在源 outputSchema.required 中；failure/always 边不得假设 success schema 的嵌套输出，只能传整个 `$output` 或 literal。X1 图因此将 `error`/`experiment_dir` 收紧为 required string，无错时使用空字符串，不再在 string schema 下示例 `null`。这是 schema/sentinel 的机械加固，未改变已验收的拓扑、权限、真值表或业务语义；修补后用最新源码 ABI 独立校验结果为 `valid: true, errorCount: 0`。

最终验收：TypeScript `typecheck` 通过，CLI 重新构建通过，Graph/Distill 定向测试通过，全量 Vitest 为 146 个测试文件、1130 项全部通过。全量并发执行曾一次触发无关的 AutoCheckpoint 时序断言，该文件单独重跑 9 项全过，紧接着再次全量执行 1130 项全过，未将偶发结果隐藏成首次即通过。

仍保留少量明确的后续项：生产 webhook ingress 的鉴权/限流属于接入层；journal、event inbox 的长期归档压缩和掉电级 fsync 属于存储演进；跨时区日历/Cron 只有出现真实需求时才考虑增加一个小型持久能力。Lane 的 canonical 路径所有权与控制面 deny 已硬执行，但 `append_only/atomic_replace` 对任意 bash 脚本仍是语义合同；若未来必须把它提升为对抗性安全边界，应在 OS sandbox 增加操作级媒介，而不是继续扩充 Graph/Distill 字段或用脆弱的 shell 文本解析限制 Agent。
