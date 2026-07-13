# Loop Distill 完整示例：Gradmotion 长周期研究

本例展示 `builtin/research@1` 下的完整作者态 Charter。Research Scenario 的
`finding`、`direction` ArtifactSpec 与有序 GateBinding 由注册表在 `loop create`
时冻结，所以不在草案中重复手写。

关键边界：

- `skill`、`timer`、`return_result` 是内核基础工具，不放进 `seat.tools`。
- 临时 Gradmotion payload 使用实例 scratch，不写仓库根目录。
- `~/.account-pool` 必须先由操作员在 `sandbox.writeAllowPaths` 中授权；
  `hostRequirements` 只做预检，不会扩大权限。
- Git 通过 `vcs_publish` 提交和推送，不给 worker 开放 `.git/**`。
- 训练曲线是否进入平台期需要语义判断，因此使用 `timer + lineage_loop`；如果后续注册
  Gradmotion EffectAdapter，可把纯状态跟踪迁入 `effects`，但平台期判断仍由 worker 收割。
- Judge Gate 的 `rubric` 是唯一评审语义来源，`seats.judge.prompt` 不复制它。

```json
{
  "id": "x1-walking-control-v3",
  "version": 1,
  "goal": "为 X1 建立稳定自然的前进行走策略；同一 epoch 同时满足 single_contact > 0.8、walk_forward_vel > 0.3 m/s、zero_contact < 0.15、episode_length > 500，且无 reward hacking。",
  "scenario": "builtin/research@1",
  "effects": {},
  "projections": [],
  "metric": {
    "direction": "max",
    "onAbsent": "skip_update",
    "onError": "fail_stop",
    "onNull": "skip_update"
  },
  "observables": [
    {"name": "new_findings_count", "source": {"from": "judge", "key": "new_findings_count"}},
    {"name": "metric_delta", "source": {"from": "judge", "key": "metric_delta"}}
  ],
  "meters": [
    {"name": "iteration", "inc": "every_round"},
    {
      "name": "stale_count",
      "incWhen": "new_findings_count == 0 || metric_delta <= 0",
      "resetWhen": "new_findings_count > 0 && metric_delta > 0"
    }
  ],
  "tripwires": [
    {
      "when": "stale_count >= 4",
      "then": {"act": "escalate", "reason": "连续四轮无有效进展", "onResume": {"resetMeters": ["stale_count"]}},
      "onAbsent": "fail_stop",
      "onError": "fail_stop"
    },
    {
      "when": "stale_count >= 2",
      "then": {"act": "pivot"},
      "onAbsent": "fail_stop",
      "onError": "fail_stop"
    }
  ],
  "gates": {
    "findings_quality": {
      "kind": "judge",
      "evidence": [
        "drafts/findings_draft.json",
        "ledger/findings.jsonl",
        "ledger/progress.json"
      ],
      "rubric": "有效 finding 必须是非重复机制结论，并包含 task_id、git commit、epoch 和具体指标。metric 使用本轮同一 epoch 的综合质量分数；metric_delta 是相对历史 best_metric 的改善。goal_satisfied 仅当同一 epoch 满足 Charter goal 的全部阈值且无 reward hacking 证据。verdict=pass 当且仅当至少一个 finding 有效；否则 fail，messages 必须给出具体缺失证据或纠偏动作。"
    }
  },
  "seats": {
    "worker": {
      "context": "lineage_loop",
      "prompt": "从未尝试方向中选择一个，读完整实现后只在 writeScope 内修改。加载 gradmotion skill。修改完成后调用 vcs_publish；把 Gradmotion payload 写入内核 scratch，并从 scratch 目录用相对路径提交和启动任务。记录 task_id 后 timer 30 分钟。唤醒后检查任务与诊断曲线：仍明显改善则再次 timer，进入平台期则停止任务，提取带 task_id、commit、epoch 和数值证据的 findings。",
      "skills": ["gradmotion"],
      "tools": ["read_file", "edit_file", "write_file", "grep", "glob", "bash", "spawn_sub_agent"],
      "capabilities": {"vcsPublish": {"remote": "origin"}},
      "hostRequirements": {"writePaths": ["~/.account-pool"]},
      "budgetPerRound": {"usd": 4, "turns": 80, "wallclockMin": 60}
    },
    "judge": {
      "context": "isolated",
      "prompt": "你是严格、保守、只认证据的机器人训练实验评审。",
      "budgetPerRound": {"usd": 0.5, "turns": 10}
    },
    "pivoter": {
      "context": "isolated",
      "prompt": "提出改变假设、证据源、训练阶段或评估结构的具体转向，不做参数微调。",
      "inputs": ["ledger/directions.json", "ledger/findings.jsonl"]
    },
    "finalizer": {
      "context": "isolated",
      "prompt": "按核心成果、最佳证据、未竟目标和后续建议生成收尾叙事。",
      "inputs": ["ledger/progress.json", "ledger/findings.jsonl"]
    }
  },
  "budgets": {
    "perRound": {"usd": 5},
    "lifetime": {"rounds": 20, "usd": 100}
  },
  "health": {
    "staleWhen": "stale_count > 0",
    "onAbsent": "fail_stop",
    "onError": "fail_stop"
  },
  "writeScope": [
    "humanoid/envs/x1/**",
    "humanoid/envs/base/**",
    "humanoid/algo/**"
  ],
  "roundIntervalMs": 0
}
```

对应的 `task_spec.draft.md` 只是人工部署/审阅附件，应至少列出：skill 安装、账号池
路径授权、Git remote 可推送、Gradmotion CLI 可用性和首轮 dry-run 检查。它不会被
`loop create` 自动执行；任何运行时关键约束必须进入 Charter。
