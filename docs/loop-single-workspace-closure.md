# Loop 单 workspace 闭环契约

状态：2026-07-13 收敛基线。本文只描述当前承诺支持的单 workspace、单宿主部署；不包含跨
workspace 全局配额、跨集群调度或不受信第三方插件加载。

## 1. 宿主必须提供什么

1. 冻结并创建一个 Charter/Loop instance。
2. 若 Charter 声明 `effects`，宿主必须在同一个 `EffectAdapterRegistry` 注册每个版本化
   adapter ID，并把该 registry 传给 `tickOnce` 或 `runLoopScheduler`。
3. adapter 的远端 submit 必须以 `context.effectKey` 作为稳定幂等键，并服从 `AbortSignal`。
4. Human Gate 只能通过宿主侧 `writeAuthenticatedEffectEvent` 写入审批；worker 无权写
   `events/`，签名密钥不在 workspace。

冻结 binding 存在但宿主没有注册 adapter 属于部署配置错误：当前 wake 当次 fail-stop、实例
进入 `failed`、所有 live wakes 被取消；不会要求 worker 猜测修复，也不会进入重试热循环。

## 2. 完整状态闭环

```text
worker return_result(label=wait, effectBinding, effectKey)
  → persist pending_round
  → append durable submit intent
  → adapter.submit(effectKey)
  → adapter_ack / bounded retry
  → effect_poll or authenticated event
  → typed observation + ordered Effect Rule
  → exactly one terminal branch:
       harvest                → resume same round → Gate/Artifact/Route
       cancel_and_harvest     → confirmed cancel → resume same round
       escalate              → audited round → attention_report → paused_attention
       fail_stop             → retain pending/effect evidence → failed
       deadline              → confirmed cancel + harvest, otherwise fail_stop
```

event 与 poll 的 terminal result 共用 EffectLedger 的单一 first-wins CAS。poll 返回 pending 时只
推进硬状态并重新调度 `effect_poll`，不启动 LLM seat。daemon kill/restart 后，reconcile 从
`pending_round + effects.jsonl + wakes` 重建同一状态；ambiguous submit 优先调用 reconcile，不能
换 effectKey 创建第二个逻辑远端任务。

恢复路径不得静默吞错：只有事件文件已被另一个 ingester 移走的 `ENOENT` 可视为正常竞争；权限、
存储和账本错误必须向上暴露。可识别的账本损坏会在准备调度阶段把实例 fail-stop 并取消 live
wakes；冻结 adapter 缺失、规则 fail-stop 和 reconcile 得到 failed effect 也都在同一 pass 收敛，
不依赖下一次 daemon tick。

## 3. 当前 EffectBinding 约束

```json
{
  "effects": {
    "training": {
      "adapter": "example/training@1",
      "observations": {
        "status": {"pointer": "/state", "type": "string"},
        "balance": {"pointer": "/data/balance", "type": "number"}
      },
      "rules": [
        {
          "when": "status == 'succeeded'",
          "then": {"act": "harvest", "verdict": "completed"},
          "onAbsent": "fail_stop",
          "onError": "fail_stop"
        },
        {
          "when": "balance <= 0",
          "then": {"act": "cancel_and_harvest", "verdict": "balance_exhausted"},
          "onAbsent": "continue_waiting",
          "onError": "fail_stop"
        }
      ],
      "admission": {"maxConcurrentCalls": 2, "minIntervalMs": 1000}
    }
  }
}
```

worker 只返回 `{"label":"wait","effectKey":"稳定远端ID","effectBinding":"training"}`；它不能
选择 raw adapter、改 observation pointer、改规则或扩大 admission 上限。

## 4. 示例验收清单

一个本地示例至少验证：

- submit 只创建一个远端任务，ack 丢失后的 reconcile 仍使用原 effectKey；
- 第一次 inspect=pending 不产生新 seat，下一次 terminal 才恢复同一 round；
- event 先到和 poll 先到各测试一次，只有一个 terminal outcome；
- observation 缺失、类型错误、adapter timeout、取消不确认分别进入声明的确定性路径；
- daemon 在 submit intent、remote submit、adapter ack、terminal conclude、harvest wake 各边界
  被终止后，重启能恢复或 fail-stop；
- `loop pause/resume/stop` 在 waiting 状态下不丢 pending cost、不会遗留未确认远端任务；
- 最终 Artifact transaction、round ledger、effect ledger、progress 和 instance status 相互一致。

## 5. 明确不在本基线内

- 多 workspace 共享 provider 的全局 admission；
- 跨集群 lease/调度；
- 企业 IdP、SecretBroker 和 credential rotation；
- 动态加载的不受信 adapter/plugin；
- 忽略 AbortSignal 的同进程恶意 adapter 强制终止。

这些能力后续必须通过独立 broker 或子进程隔离实现，不改变本文的 effectKey、ledger、Rule 和
terminal 状态语义。
