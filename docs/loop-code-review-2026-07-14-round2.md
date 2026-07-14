# Loop 泛化与可靠性优化 — 第二轮评审（2026-07-14）

评审对象：工作区未提交改动（基于 7fdb442,+1492/-547,新增 13 个文件）。
验证状态：`tsc --noEmit` 干净;`vitest src/loop` **262/262 全绿**(较上轮 +18,新增
ScenarioHost/ScenarioPlugin/wake token/HostCoordinator 等用例)。

## 总评

这轮改动的方向和执行都对。泛化目标实质达成:**内核业务词汇清零**——findings/
directions 从核心账本(`types.ts`,InstancePaths 删除两字段)移入 Research 场景私有
read model(`ResearchPaths.ts`);场景能力收敛为带版本与 integrity 的插件契约
(`ScenarioPlugin.ts`),冻结进 charter(`CharterValidate.ts:642` scenarioPlugin pin),
所有 hook 经 `runScenarioHook` 施加 30s 超时 + 1MB 输出上限(`ScenarioHost.ts`);
Artifact 提交收归内核唯一管线(`ArtifactPipeline.ts`,"plugins may provide gate
verdicts, only the kernel commits")。

可靠性侧同样扎实:wake claim 从 TTL 心跳升级为 **token CAS 围栏**(`WakeStore.ts:211
assertClaim`、release/heartbeat/addAbortedCost 全部带 token,`WakeClaimLostError`
在 runner 单独处理不碰 wake);charter 迁移改为**两阶段 marker + 加载时幂等恢复**
(`MigrationRecovery.ts`,新增 'migrating' HALTED 状态);`reconcileCommittedTerminal`
修复了"终态已入账但报告/状态未落地"的尾部;`consumedInboxFiles` 记入 pending 与
RoundEntry,闭合了上一轮 #4 遗留的"账本提交后、inbox 归档前崩溃 → 反馈二次消费"
窗口;EffectRuntime 把 admission 排队与执行超时分离(修掉排队吃执行预算的隐患);
EffectLedger 全面有界化(event 1MB/历史 256 条/10 万 key/终态 payload 释放);
HostScheduler 加了 writer barrier 防独占等待者饿死;load 时校验 frozen charter
hash(防手改)。上一轮 16 项修复全部保留且被围栏进一步加强。

以下问题按严重程度列出。没有发现会立即出错账的缺陷;最重的一项是运维死锁。

---

## P1-1 插件升级会"砖死"存量实例,且没有逃生门

pin 校验是无条件的:`InstanceStore.ts` loadInstanceFrom →
`scenarios.assertCompatible(normalized.frozen.scenarioPlugin)`,version 或
integrity 任一不符即 throw。而 integrity 是入口文件内容哈希(`ScenarioLoader.ts:20`)
——插件文件**任何**变更(哪怕完全兼容的 bugfix)都会使所有 pin 了旧 integrity 的
存量实例:

- 调度侧:prepareAndClaim 捕获 `ScenarioPluginError` 放入 blockedPluginLoops,
  wakes 永久 pending → daemon 因有 live wake 永不 idle-exit,且每 2s poll 对每个
  blocked 实例打一条 console.error(日志风暴 + 实例静默滞留,状态仍显示 idle);
- 运维侧:**`loop migrate` 也要先 loadInstance** → 同样 throw → 无法迁移到新插件
  版本。唯一解法是找回字节级相同的旧插件文件。re-pin 需要 freezeCharter,
  freezeCharter 需要 load,死锁闭合。

建议:(a) 给 migrate 路径加 `allowPluginMismatch` 的受控加载(只允许进入
freezeCharter re-pin 流程,不允许跑 seat);或提供 `loop plugin repin` 命令在
workspace 操作锁内直接重写 frozen.scenarioPlugin + charterHash;(b) blocked 实例
写 statusReason(不改 status)并对日志限频,让 `loop list` 可见而不是刷屏。

## P2-2 围栏是"检查后写",不是原子提交——注释措辞强于实际保证

`completeRound` 在 appendRound 前 `await assertWakeFence(deps)`
(`LoopKernel.ts`),但账本 append 不在 wake 锁临界区内:assertClaim 释放锁到
appendJsonl 落盘之间,claim 仍可能被 reconcileOrphans 回收并重新 claim——两个执行
体在这个窗口内可以都通过各自的 assert。窗口从旧实现的"整轮"缩到毫秒级,工程上
接近够用;但注释宣称 "the Round ledger is not allowed to advance until the fence
is revalidated" 过强。要么把关键 append 放进 wake 锁(牺牲锁粒度),要么把注释与
文档降级为"缩窗最努力语义",避免后来者据此做更强假设。

## P2-3 replay 会丢 obligation 升级路由

`ArtifactPipeline.ts:131-140`:alreadyCommitted 分支返回 `obligationErrors: []`。
时序:首次尝试 obligation 失败(each_round 草稿缺失)但事务照常提交 → 在
appendRound 前崩溃 → 重放轮拿到 alreadyCommitted + 空 obligationErrors →
completeRound 里本应触发的 `escalate: Artifact obligations failed` 变成 continue。
且 cleanupDrafts 已删草稿,重算不可能。建议把 obligationErrors 随事务(或
checkpoint)持久化,replay 时原样返回。

## P2-4 integrity 只覆盖插件入口文件

`loadScenarioPlugins` 的 sha256 只对 entry file;插件 `import` 的兄弟模块变更不会
改变 integrity——pin 的防漂移保证明显弱于它的表面承诺(一个多文件插件可以在
integrity 不变的情况下行为完全改变)。文档(scenario-plugins.md)应显式声明这一
边界;bare package 场景可叠加 package.json version 锁定,本地插件建议单文件打包。

## P3(小项)

- **确定性错误走了 5 次退避重试**:`EffectLedger.append` 超 1MB 与
  `MAX_EFFECT_KEYS_PER_INSTANCE` 触顶都 throw 普通 Error → runner 归入未分类 →
  5 次退避后才 failed。两者都是确定性失败:key 触顶应直接 fail-stop;payload 超限
  更好的归宿是像 wait_contract 一样给 worker 一次【纠偏重试】(它是 worker 输出
  造成的,模型可修)。
- `reconcileCommittedTerminal` → `cancelWakesFenced` 会把当前 claimed wake 置
  cancelled,随后 runner 又以 token 覆盖为 done——审计流转 claimed→cancelled→done
  略怪,建议 cancel 时跳过 fence 自身的 wakeId。
- `buildCapsule` 无 scenario 时静默落 `id:'unbound'` 空视图——当前仅测试路径,
  若生产代码误用会无声丢掉场景上下文,建议在 kernel 外的调用直接断言。
- adapterCall 的 admission 超时 = min(deadline 余量)可长达数天,队列项长期驻留
  常驻 daemon 内存;有 abort 联动,可接受,但建议加一个小时级硬上限。
- ScenarioLoader 用 `?scenarioIntegrity=` 做 ESM cache-bust:同进程反复 load 会
  累积模块缓存。当前 CLI 每进程只 load 一次,无实害;若未来 daemon 支持热重载需
  换机制。

## 与上一轮报告的对账

上轮 16 项:全部保留且多数被本轮加强(#6 pause 竞态在 token 围栏下从"窄窗"进一步
收紧;#4 inbox 事务化补上了 consumedInboxFiles 的最后一块;#7 成本转移路径未回退)。
上轮标注"遗留"的两项也处理了:runner 错误分支已收敛(failStopLoop),双心跳保留但
runRound 侧已带 token 无害化。

## 建议测试补充

1. 插件 integrity mismatch 下的 migrate 逃生路径(修复 P1-1 时一并加,当前这是
   能力缺口而非纯测试缺口)。
2. alreadyCommitted × obligationErrors 组合的 replay 路由(P2-3 的回归)。
3. blocked 实例在 `loop list` 中的可见性。

结论:可以合入。P1-1 建议在放出任何"允许自定义插件"的版本前解决——它不是正确性
bug,但会在第一次插件升级时变成生产事故;P2-2/P2-3 随后跟进即可。
