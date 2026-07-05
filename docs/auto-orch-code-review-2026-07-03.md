# auto_orch 模式代码与功能审查报告

日期：2026-07-03 ｜ 分支：main（HEAD 7ea4c79）｜ 范围：`src/core/auto_orch/`（24 文件，约 5500 行）及其在 modes / routing / kernel / subagent / cli 的集成面。

验证基线：`tsc --noEmit` 通过；`vitest run src/core/auto_orch` 7 个文件 115 条测试全绿。

---

## 一、总体评价

架构是这套代码最强的部分，核心安全设计在实现里真实兑现了：

- **编排即数据**：Planner 只产出 OrchPlan JSON，固定的 `PlanRunner` 解释执行；`validatePlan` 在执行前拦截非法图（唯一 id、边引用、写节点隔离、并行写域、code 节点契约），加上 Tarjan SCC 的优雅终止检测，死环在静态期就被拒绝并回灌错误让 Planner 重产。
- **双层封顶**：visits / steps / cost / wall-clock 四个硬上限由解释器强制，与计划内容无关；`PlanRunner.run` 全路径不抛异常，永远落成可路由的 `PlanRunResult`。
- **fail-open 与 fail-closed 分工正确**：Planner 任何失败回退单执行器计划（永远可跑）；而审查门 skip（reviewer 没跑成/输出不可解析）在 `PlanRunner` 被 fail-closed 成 `review_unavailable`，且在 `selectNext` 之前检查，边拓扑无法把 skip 洗白成 pass——这个细节做得很好。drift 因其 advisory 性质豁免，区分合理。
- **Blackboard 按拓扑寻址**：纠偏消息由 PlanRunner 按边的目标节点投递（agent 地址无关），corrective 恰好一次消费、output 持久可扇入，修正环真正闭合。
- **零回归的 phase hook**：内核只认 `PhaseHookFn`，`config.phaseHooks` 缺省时直接 return；auto_orch 经首轮 `pre_query` 启动钩子引导整套编排，失败经 `failed:true` 映射为错误 subtype 而非假成功。
- **code 节点冻结**：内容寻址（SHA-256）+ 执行前 hash 校验 + 子进程运行 + 输出字节/超时上限 + state/ 写路径白名单，方向正确。
- 计划持久化（PlanStore 版本化 + runs.jsonl）、暂停/恢复（pause tool → durable schedule → 历史回放 resume）链路完整，工程完成度明显超出 docs/auto-orch-design.md 记载。

下面按严重度列出问题。

---

> **修复状态（2026-07-03 更新）**：H1、H3 及"图执行失败后 re-run 报 git stash 错误"已通过**运行级集成分支方案**修复（`src/core/auto_orch/RunWorkspace.ts`）：整个 run 在 `auto-orch/<runId>` 分支的私有工作树上执行，主树全程零接触；成功→一次 squash 合回 main（事务化，失败回滚且保留分支），失败/中断→整体丢弃，暂停→持久化 descriptor 供 scheduler 重挂。integrator 改为可写 + 真实合并判据（文件确实变更且无冲突标记）+ 失败不再丢弃分支。中途 stash 路径整体消失。见 `__tests__/runWorkspace.test.ts`（15 条真实 git 集成测试）。

## 二、高危问题

### H1. integrator（L3c 冲突合并）在只读沙箱下运行，且失败模式是静默丢改动
`KernelBranchOps.resolveAndMerge` 以 `workspaceMode: 'shared_readonly'` spawn integrator，却给了 `edit_file/write_file/bash` 并要求它"把两边改动融合后写回主工作区"。而 `SubAgentBridge.spawnSubAgent` 对 shared_readonly 会：
- 过滤掉 `write_file/edit_file/notebook_edit`（`filterSharedReadonlyTools`）；
- 把沙箱设为 `readonlyWorkspace: true, writeAllowPaths: [], allowUnsandboxedFallback: false`（bash 也写不了）。

结果：integrator 物理上不可能写回融合结果；但它只要"跑完"（比如只输出了一段说明文字），`resolveAndMerge` 就返回 `merged: true` 并 `wt.discard(taskId)` **丢弃冲突分支的 worktree** ——冲突分支的全部改动静默丢失，图还继续按成功路由。设计文档 §7-TODO-4 也承认此路径缺集成测试；现有测试只用 stub BranchOps 覆盖。
**建议**：改为 `shared_write`（合并循环内本就串行，注释也是这个意图）或给沙箱开写白名单到冲突文件；并且把"是否真的写了"作为 merged 判据（例如 diff 冲突文件），失败时保留分支 worktree 而不是 discard。

### H2. code 节点"沙箱"可被动态 import 直接穿透
`FORBIDDEN_CODE_PATTERNS` 拦截 `\bimport\s+`（静态 import）和 `require(`，但 **不拦 `import(`**：

```js
const fs = await import('node:fs/promises')   // 全部 14 条正则都不命中（已实测）
await fs.writeFile('/anywhere/outside/jail', ...)
```

wrapper 子进程只有 `env: {}` / `cwd: '/'`，没有任何 OS 级隔离；一旦生成的代码含动态 import，state/ 路径白名单、能力开关、禁网禁 shell 全部形同虚设。code 源码来自 LLM（code_author），威胁模型是提示注入或跑偏的生成——正则黑名单挡不住。
**建议**：至少补 `/\bimport\s*\(/`；更稳妥是运行期兜底——Node `--permission`（fs 只读 + 只放行 state/）、或 `--experimental-vm-modules` 下的 SourceTextModule 无 import 回调、或干脆在现有 sandbox executor 里跑。黑名单只能当第一层。

### H3. parallel 分支缺工具兜底：无 allowedTools ⇒ 零工具空转
`KernelBranchOps.runBranch` 用 `allowedTools: branch.allowedTools ?? []`，而 `SubAgentRunner._resolveToolsWithSandbox` 对空数组返回 `[]`（只剩注入的 return_result）。executor 节点专门为此做了 `DEFAULT_EXECUTOR_TOOLS` 兜底（KernelNodeRunner 注释还点名了这个坑），分支却没有对称处理——Planner 漏写 allowedTools 的分支会"聊天式完成"，join 视为成功。
**建议**：分支复用同一兜底（写分支给读写工具、读分支给只读工具），或在 `validateParallelNode` 里直接拒绝无工具分支。

---

## 三、中危问题

### M1. verify/drift 角色节点忽略节点的 taskDescription
`VERIFY_ROLE.buildHandler` 直接调 `makeAutoVerifyGate` 并丢弃 `criteria`（节点的审查标准），只对照全局 goal 判断。但 PLANNER_RUBRIC 明确让 Planner 给 role 节点写有意义的 taskDescription（"对照目标核对产出…"），Planner 以为在定制审查标准，实际不生效；只有 fallback 到通用 reviewer 的未知角色才真正消费 criteria。另外 `KernelNodeRunner.runRole` 构造的 RoleContext 不带 `getSessionId`（工厂里的 roleCtx 有），两处上下文不一致。
**建议**：把 criteria 作为附加 rubric 传入 verify/drift gate，或在 rubric 里明说 verify 节点的 taskDescription 仅是注释。

### M2. 成本核算漏项，maxTotalCostUsd 系统性低估
`fromVerify`/`fromDrift` 适配器不携带 `data.costUsd`，所以 verify/drift 角色节点的真实开销对 PlanRunner 不可见（通用 reviewer 有报）；Planner 自身的成本也不计入 `run.costUsd`。图的成本上限只对 executor/parallel/部分 role 生效。
**建议**：让 gate 返回成本并在适配器透传；Planner 成本至少并入 summary。

### M3. 暂停/恢复后所有 bounds 与 Blackboard 归零
`AutoOrchScheduler.continuePlanFromResumedNode` 用 `{...plan, entry: pausedNodeId}` 新建 PlanRunner：visits/steps/cost 全部从零开始，新建空 Blackboard。一个反复 pause→resume 的长任务事实上拥有无限预算（每段各算各的 maxTotalCostUsd），visitedPath/纠偏历史也断链。
**建议**：把累计 steps/cost/visits 存进 resumeHandle/schedule 记录，恢复时作为初值注入；Blackboard 至少把未消费 corrective 持久化。

### M4. 调度存储全局共享、领取非原子
schedule 与 subagent-session 记录都在 `META_AGENT_HOME`（用户级全局目录），`listDueAutoOrchSchedules` 不按 project/session 过滤：
- 两个项目各开一个 auto_orch 会话时，A 的 scheduler 会领取 B 的到期 schedule，用 A 的 dispatcher/jail 恢复 B 的子 agent；
- 跨进程的"读到 scheduled → 写 running"不是原子操作，双进程可能双重 resume 同一 schedule；
- `cancelAll` 只遍历本进程内存里的 id 集合，进程崩溃遗留的 schedule 会在下个会话被领取、resume 失败后才标 failed（能自愈但有噪音）。
**建议**：schedule 记录加 projectDir 字段并在 listDue 过滤；领取用原子重命名（`scheduled → running` 改文件名）或 lockfile。

### M5. 运维缺口：paused 之后没人保证 scheduler 活着（已修复）
- A：交互式 `auto_orch` 在 run paused 后默认前台等待，保持当前进程和 in-process scheduler 存活，直到本工作区 pending schedule 全部终结；`--no-wait`、JSON/非 TTY 或 Ctrl-C 会交接给后台守护。
- B：新增 `meta-agent orch-scheduler --project <dir>`，使用工作区级 daemon lock，空闲即退；pause 后可自动 detached spawn，并把 pid / log path 告知用户。
- D：CLI 启动时提示本工作区 pending/overdue schedule；新增 `orch-status` 与 `orch-resume [id]` 手动查看/立即恢复。
- 配套点已补：schedule 记录持久化 `planRef` 并在 daemon terminal continuation 后追加 `runs.jsonl`；terminal notice 会在下次 CLI 启动/`orch-status` 可见且可 ack；失败路径加入 `maxAttempts` + 指数退避，re-pause 也有最小 delay；final merge 的 stash restore note 会进入 resumed run note / terminal notice，不再只落 stdout。

### M6. `--auto-orch-executor-max-turns` 全局覆盖压掉节点显式预算
`this.executorMaxTurns ?? node.maxTurns ?? 30`：CLI 覆盖一旦设置，Planner 按 rubric 特意调大的节点（建议 60–120 turns）也被压到全局值，且无告警。直觉语义应是"缺省值"或取 min/max 策略。

### M7. 若干语义边角（已修复）
- `PlanRunner` 现在先处理 `label:"paused"`，再做总成本上限检查；节点 pause 的同时 cost 越限会落成 `paused` 并携带 `resumeHandle`，避免已写 `paused_waiting_external` 的子 agent session 没有 schedule 可恢复。
- `verdict.action === 'abort'` 不再一律视为完成：默认仍表示 clean stop；当 `data.failed === true` 或 `label:"error"|"failed"` 时落成 `failed`，供 code 节点/自定义角色表达异常终止。
- `isTerminalError` 不再读取节点 id 正则；终态失败只由显式 `label:"error"` 表达，去掉 `error_writer`/`error_stop` 这类 Planner 不知道的魔法命名约定。

### M8. Planner / 预算 / 审查交互边角（已修复）
- Planner 子 agent 预算从 `maxTurns:12 / maxBudgetUsd:0.4` 提升到 `30 / 2`，匹配 rubric 里“先只读探查再设计大图”的实际成本；初始任务文案统一为“必须调用 `return_result`，`data` 为 OrchPlan JSON 对象”，不再同时要求“只输出 JSON 代码块”。
- 计划审查里用户选择 Revise 但反馈留空时，不再记成 `approvedByUser:true` 的批准；现在会把“用户选择修订但未填写具体说明”的反馈交给 Planner 重新规划。
- executor 与 parallel branch 的缺省 `maxBudgetUsd` 从 `0.5` 提升到 `2`；Planner 漏写预算时不再默认落入与 rubric 建议量级明显冲突的低预算。

---

## 四、低危 / 卫生

1. **注释与行为矛盾**：`reviewer.ts`/`KernelNodeRunner` 头注释仍说角色 skip "fail-open 成 pass 绝不卡死图"，而 PlanRunner 实际对非 drift skip fail-closed（`review_unavailable`）。行为是对的（更安全），注释过时，容易误导后续改动。
2. **设计文档失步**：`docs/auto-orch-design.md` 全文用 `src/core/auto-orch/` 与模式名 `auto-orch`（实际 `auto_orch`）；scheduler、pause/resume、code 节点、PlanStore、CLI 参数（`--auto-orch-plan` 等）均未入档；§7 状态段仍写"17 条单测"（现 115 条）。
3. **仓库垃圾**：根目录 `__trash_stale_auto_orch/`（整套旧 dist 产物）和 `__tests__/_tmp_branchcycle.removed` 应删除。
4. **解析逻辑三处重复**：`parseOrchPlan` / `parseExecutorVerdict` / `parseRoleVerdict` 各自实现"fence 扫描 + lastBrace 兜底 + 从后往前试 JSON.parse"，值得抽一个公共 helper。
5. `AutoOrchController` 的 `PROCESS_FILE_ROOTS = ['state']` 硬编码：非 completed/paused 结局回滚整个 `state/` 到 run 前快照。对 `aborted`（用户 Ctrl-C）也回滚，可能抹掉有价值的中间产物，且用户工作区若本来就有 state/ 目录会被一并管控——值得在文档里显式声明这个约定。

---

## 五、测试评价

- 覆盖面好：验证器（含终止检测健全性）、PlanRunner 循环/封顶/fail-closed、Blackboard 寻址/消费语义、并行 join/merge 规划、planner 重试与 fallback、scheduler 恢复链路都有针对性用例；rubric 里的示例 JSON 还被拿来直接做解析+校验回归，防提示词腐烂，是个好实践。
- 关键缺口与 H1/H2 完全重合：`KernelBranchOps.resolveAndMerge` 的真实 git+子 agent 路径零覆盖（只有 stub）；`reviewCodeNodeSource` 没有对抗性用例（动态 import、字符串拼接逃逸）。pause 时 cost 越限、abort verdict 语义、终态错误命名约定、Planner 预算/输出契约、Revise 空反馈、默认节点预算、M5 keepalive/daemon result notice/退避这些边角已补回归覆盖。

## 六、建议修复顺序

1. H1（integrator 只读 + 静默 discard）——有真实数据丢失风险，先修判据与 workspaceMode；
2. H2（code 沙箱动态 import）——一行正则救急，运行期权限兜底跟上；
3. H3 / M1 / M6——三个都是"Planner 意图被引擎静默改写"类问题，代价小收益大；
4. M3 / M4 / M5——pause/resume 是新链路，跨恢复 bounds、全局 store 归属、进程存活策略需要一次系统性收口；
5. 文档与注释同步（四.1、四.2），避免下一个改动者按过时契约推理。
