# Distill 产出不可运行图的根因分析（机制审查，非特例补丁）

日期：2026-07-19
范围：`src/loop/graph/distill/**`（GraphDistiller / GraphDistillTools / DistillDesign / ForegroundGraphDistillExecutor）、`src/loop/cli.ts`、`src/cli/index.ts` 的 loop 命令接线、`GraphCatalog.ts`、`GraphValidate.ts`
问题：以 X1 案例为线索，回答"distill 为什么产出不准确的结果——是 graph loop 机制太复杂？是 distill prompt 没讲清楚？还是别的原因？"

---

## 〇、先修正我上一轮报告的两个误判

诚实起见先说清楚：X1 审查报告里的 P0-1、P0-2 在读完 distill 源码后需要修正，**而这两个误判本身恰好暴露了真正的机制问题**。

**P0-1 修正（"没有 loop.graph.json，distill 未完成"→ 实际是默认文件名）。** `loop distill` 的 `--out` 默认值就是 `loop.graph.draft.json`（cli.ts L79），用户没传 `--out`，所以产物名就是 draft。从证据链看 distill 是**成功完成**的：`writeDistillArtifacts` 只在编译+审阅全部通过后调用（GraphDistiller L394-405）、semantic review accepted、`.loop/distill` checkpoint 已清空（成功后 `checkpoint.clear()`）。真正的问题是 **guide 快速开始写的是 `--out loop.graph.json`，而 CLI 默认是 draft**——两处不一致造成"看起来没完成"的误读。

**P0-2 修正（"loop create 会拒绝 sleep"→ 只在库默认目录下成立）。** `runLoopCommand`（cli/index.ts L5060-5080）在进程启动时用 `createStandardTools({mode:'auto'})` 的真实工具集**覆盖** `graphCatalog.agentTools`，`sleep` 是标准 system 工具且不在 `AUTO_DENIED_TOOL_NAMES` 里——所以 CLI 生命周期内（distill/create/tick/scheduler 共用这一个目录），`sleep` 是合法的，`loop create loop.graph.draft.json` 能成功。我上一轮用 `createDefaultGraphRuntimeCatalog()`（即 `DEFAULT_GRAPH_AGENT_TOOLS`，不含 sleep）复验才被拒。**同一张图的 "valid" 结论取决于从哪个入口验**——这不是我的误判那么简单，而是下面 C1 要说的"目录双源"问题。

**P0-3（`$input.pivotProposal` 启动即死）完全成立，是本案唯一真正的致命产出缺陷**，CLI 全链路没有任何一层能拦住它。根因见 A 层。

---

## 一、回答核心问题：不是机制复杂度问题

先给结论：**graph loop 机制本身不复杂，模型把"难"的部分全做对了**。X1 draft 里拓扑合并（8 阶段 lower 成 6 节点）、两段式 when+reducer 确定性 reduce_progress、三态 verdict 不塌缩、单写者 lane 拆分、hard-park 轮询、预算三层配置——这些是 ABI 里信息密度最高的部分，全部正确（我上一轮已在真实 Kernel 上仿真验证控制面闭环）。

失败的三个点（`$input` 严格引用、identity 嵌套、写路径/前置文件脱离实际项目）有共同特征：**都不是"复杂"的部分，而是 ABI 的隐式语义 + 校验责任的缝隙**。分四层说。

## 二、A 层：机制层的语义陷阱（3 个，都不是复杂度）

**A1. ref 的严格语义没有任何一层声明，且 ABI 缺"可选输入"惯用法。** 这是 P0-3 的直接根因。运行时 `resolveReference`/`readPath` 对缺失的 `$input.x` **抛错**（GraphJson L71），而 `when` 条件里缺失引用是**静默不匹配**（GraphExpression L42 有注释）。同一个 `$` 引用在两处语义相反。检查了模型能看到的全部输入：
- `graph_reference` 的 7 个 section（overview/nodes/workspace/lanes/control/capabilities/example）——**没有任何一处**说明"入边未绑定的 $input 引用会让 Activation 失败"；
- Compiler system prompt（L667-701）讲了 workspace 对照、三态语义、annotations 不注入等十几条边界，**唯独没讲输入数据流闭合**；
- canonical example 里 node.inputs 只用 `$state` 引用，transition target inputs 只在 happy path 传 `$output`——没有任何"可选输入"的示范 pattern。

X1 需求天然要求"pivotProposal 只在 pivot 路径存在"，模型没有可抄的 pattern，就写出了一个语义上自然、运行时致命的图。**模型不是没理解机制，是机制没告诉它这条规则。**

**A2. "所有入边必须供给节点声明的 $input 引用"是可静态判定的不变量，却不在 validator 里。** GraphValidate 对 ref 只查根正则（`ROOT_RE`，L321），从不交叉核对入边绑定。而这个检查是纯图论的：对每个节点收集 `node.inputs`/`terminal.result` 里的 `$input.x`，检查每条入边的 `target.inputs` 和每个 entrypoint 是否都绑定 `x`。设计文档自己说"Validator 只做可执行不变量，Reviewer 承担不能机械证明的语义等价性"——这一条明明可机械证明，却谁都没管（见 B2 的责任缝隙）。

**A3. `builtin/identity@1` 的返回形状是个隐坑。** manifest 描述只有一句 "Return the input object."（返回**整个** inputs 记录）。`graph_reference(nodes)` 的 function 模板恰好演示 `inputs: { value: {ref: '$input.value'} }`——模型照抄后自然把下游写成 `$output`，得到 `{value: X}` 嵌套。文档准确但不足以防误用；没有 `builtin/pluck` 之类的取值函数，也没有示例演示"identity 输出要用 `$output.value` 解包"。

## 三、B 层：Distill 三阶段的职责缝隙（这是流水线设计问题）

**B1. Compiler 被明确禁止看项目，Architect 却没被强制核实写路径。** Compiler prompt：「不读取需求文件、不扫描项目」（formatDistillSourceIdentity）——职责隔离本身合理。于是项目事实全靠 Architect：它的 prompt 说「只有设计依赖项目结构…时，才用 glob/grep/read_file 做最小充分检查」。写路径设计**显然**依赖项目结构，但这只是个软性建议，没有"每个 write path 必须确认存在、或显式标记为新建"的硬要求。结果：Architect 发明了项目里不存在的 `src/`，漏掉了真实代码所在的 `humanoid/`，也没发现 `state/task_spec.md` 不存在。

**B2. Reviewer 的五层清单覆盖不到"数据流闭合"和"运行前置条件"，且被明确告知不做机械检查。** Reviewer system prompt 第一句：「候选 Graph 已通过 ABI Validate 与 Freeze。你不重做字段 lint」。它的五层是 intent/workspace/lane/control/capability——没有 dataflow 层，没有 preconditions 层。于是 `$input.pivotProposal` 这类问题落进缝里：**validator 认为它是语义问题，reviewer 认为它是 lint**，两边都对，两边都不查。X1 的 semantic review 给出 Accepted: yes 全 pass 不是模型失职——是清单里根本没有这两项。

**B3. `ask_user` 超时静默取默认，unresolved 项不阻断。** review.md §6 白纸黑字写着 U1「user confirmation timed out」→ 默认 maxIterations=20，U2 taskDir 假设为项目根——只留下"Human review recommended"散文。unresolved 约束没有机器可读的产物、不阻断 create、下一步没有任何强制确认动作。前置条件（task_spec.md、gm CLI、账号 key）同样只存在于 review.md 的散文里（§8），`loop create` 不做任何 launch precondition 检查。

## 四、C 层：工程一致性问题（双源真相）

**C1. graph_agent 工具目录有两个来源，"valid" 不可传递。** cli/index.ts L5070 的注释自己讲了历史：Distill 曾用交互工具集验证、Create 用 DEFAULT、Tick 注册 Auto 工具，导致"validated 之后立刻被 create 拒绝"；修复方式是**每次 CLI 进程重建一个目录**给四个环节共用。但这个修复留下了新的双源：
- `DEFAULT_GRAPH_AGENT_TOOLS`（GraphCatalog.ts，10 个工具，不含 sleep）——库默认、被文档隐含引用、被测试使用、被任何 embedder/编程调用方通过 `createDefaultGraphRuntimeCatalog()` 拿到；
- CLI 实际目录 = `createStandardTools({mode:'auto'})` 的全集（含 sleep、mcp_call 等，随工具集演进而漂移）。

同一张 frozen 图，CLI 里 create 成功，换个入口（测试、库调用、未来的服务化）就 integrity/validate 失败。loop-runtime-guide 承诺「Compiler 校验、loop create 和 Scheduler 使用同一个 Tool Catalog」——在单次 CLI 进程内为真，跨入口为假。我上一轮的误判就是这个双源的直接受害者，这本身就是最好的 bug 证明。

**C2. 产物命名不一致。** guide 快速开始 `--out loop.graph.json` vs CLI 默认 `loop.graph.draft.json`。小事，但直接制造了"distill 没完成"的误读。

## 五、结论：三个候选答案的裁决

| 候选原因 | 裁决 | 依据 |
|---|---|---|
| graph loop 机制太复杂？ | **否** | ABI 很小（6 节点类型、3 种 ValueExpression）；模型在最难的拓扑/确定性路由/三态/预算上全对；错的三处全是简单点位 |
| distill prompt 没讲全 graph loop？ | **部分成立** | 缺的不是"全面介绍"，是 3 条精确规则：ref 严格语义与可选输入惯用法（A1）、identity 返回形状（A3）、写路径必须对项目核实（B1）。盲目加长 prompt 反而有害——现有 prompt 已经很长且讲对了大部分 |
| 其他原因？ | **主因** | ① 可机械判定的不变量没进 validator，而 reviewer 被告知不做机械检查——责任缝隙（A2+B2）；② 工具目录双源（C1）；③ unresolved/前置条件无机器化出口（B3） |

一句话：**这不是模型能力或机制复杂度问题，而是"校验器少一条不变量 + ABI 少一个惯用法 + 流水线少两个机械关口"的系统问题。** 同类需求（条件性数据流、依赖项目结构的写路径、需要 bootstrap 的状态文件）都会稳定复现，与 X1 无关。

## 六、通用修复建议（按杠杆排序，都不是特例补丁）

1. **Validator 新增数据流不变量**（消灭 A1/A2 全类问题）：对每个节点 `inputs`/`terminal.result`/wait `correlation` 中出现的 `$input.x`，静态检查每条入边 target.inputs 与每个指向该节点的 entrypoint 是否都绑定 `x`，缺失即 error。纯图遍历，~30 行，直接把"启动即死"拦在 freeze 之前。
2. **ABI 补可选输入惯用法并写进 graph_reference**：短期在 nodes/control section 加一段——"$input 引用是严格的：任何入边未绑定即 Activation 失败；可选值必须在所有入边显式绑定 {literal: null}"，并在 canonical example 中演示一次条件性输入。长期可考虑 `{ref, default}` 形式（需连同 validator/freeze 一起变更）。
3. **工具目录单源化**（消灭 C1）：`DEFAULT_GRAPH_AGENT_TOOLS` 不再手写，由 `createStandardTools({mode:'auto'})` 的名字集派生（或删除库默认、强制显式传入）；加一条回归测试断言 CLI 构建目录 == 库默认目录。文档写明目录的唯一出处。
4. **launch preconditions 机器化**（消灭 B3 后半）：distill 产出结构化 `loop.preconditions.json`（必须存在的文件、外部 CLI、密钥、待人工确认的 unresolved 项）；`loop create` 默认校验并列出缺失，`--force` 可跳过。Architect prompt 同时加硬规则："每个 write path 与每个 prompt 声明读取的文件，要么确认存在，要么写进 preconditions"。
5. **Reviewer 清单补一层或明确让渡**：五层加 `dataflow_preconditions` 层；或在 reviewer prompt 里明确"数据流闭合与前置条件由 validator/create 机械保证，不在你的职责内"——关键是消除责任缝隙，谁查都行，但必须有人查。
6. **identity 防误用**：manifest 描述改为 "Return the ENTIRE inputs record（下游用 $output.<key> 取值）"；graph_reference 的 function 模板顺手演示下游 `$output.value`；可选提供 `builtin/pluck@1`。
7. **命名对齐**：`--out` 默认改为 `loop.graph.json`，或 guide 改用 draft 名——二选一。
8. **ask_user 超时策略**：非交互 distill 中 unresolved 的 hard-boundary 问题应 fail 而非默认；soft 项默认后必须进 preconditions 强制 create 时提示。

其中 1、3、4 是纯机械关口，不依赖模型变聪明；2、5、6 是把隐式契约显式化。全部落地后，X1 的三个产出缺陷在 distill 阶段就会被拦截或显式暴露给人工。

---

*本分析与前两份报告（graph-loop-audit、x1 loop.distill-audit）构成一组：主审核的 L6（ref/when 语义不对称）是 A1 的机制侧表述；X1 案例是本分析的实证样本。*
