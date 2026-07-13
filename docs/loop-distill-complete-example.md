# Loop Distill 完整示例：通用远端实验研究

本例展示 `builtin/research@1` 下的完整作者态 Charter。Research Scenario 的
`finding`、`direction` ArtifactSpec 与有序 GateBinding 由注册表在 `loop create`
时冻结，所以不在草案中重复手写。

关键边界：

- 本文中的 `experiment-runner`、`~/.experiment-runner`、`docs/prior-decisions.md`
  和业务目录都是演示实例值，不是 Loop 约定。真实 Charter 只能使用当前项目已验证的值。
- `skill`、`timer`、`return_result` 是内核基础工具，不放进 `seat.tools`。
- 临时 CLI payload 使用实例 scratch，不写仓库根目录。
- `~/.experiment-runner` 必须先由操作员在 `sandbox.writeAllowPaths` 中授权；
  `hostRequirements` 只做预检，不会扩大权限。
- Git 通过 `vcs_publish(message, paths)` 提交和推送；`paths` 只列本轮修改的精确文件，
  不给 worker 开放 `.git/**`，也不批量提交整个 writeScope。
- 实验中间结果是否进入平台期需要语义判断，因此使用 `timer + lineage_loop`；如果后续注册
  对应 EffectAdapter，可把纯状态跟踪迁入 `effects`，但平台期判断仍由 worker 收割。
- self-timer 由 `waitPolicy` 同时限制 park 次数和单轮累计等待时间；达到边界后强制最终收割。
- 经项目审阅确认存在的 `docs/prior-decisions.md` 通过
  `workspace:docs/prior-decisions.md` 只读注入 Judge/Pivoter。`workspace:` 接受安全的项目
  相对路径，不预设任何目录名；该证据用于避免重复旧方向，不导入或改写新实例 Ledger baseline。
- Judge Gate 的 `rubric` 是唯一评审语义来源，`seats.judge.prompt` 不复制它。

```json
{
  "id": "remote-experiment-research",
  "version": 1,
  "goal": "通过可复现实验把质量分数提升到 0.85 以上，且稳定性分数不低于 0.80；每条结论必须附任务 ID、配置版本和数值证据。",
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
        "ledger/progress.json",
        "workspace:docs/prior-decisions.md"
      ],
      "rubric": "逐条评审 findings 数组。有效 finding 必须是相对 ledger 与内嵌项目证据均不重复的机制结论，并包含 task_id、配置版本、复现条件和具体指标。accepted_finding_indexes 只列通过全部条件的零基索引，new_findings_count 必须等于其长度。metric 使用本轮最佳质量分数；metric_delta 是相对当前 Ledger best_metric 的改善。goal_satisfied 仅当同一实验满足 Charter goal 的全部阈值且证据完整。verdict=pass 当且仅当 accepted_finding_indexes 非空；否则 fail，messages 必须按索引给出缺失证据或纠偏动作。"
    }
  },
  "seats": {
    "worker": {
      "context": "lineage_loop",
      "prompt": "依据胶囊与已内嵌项目证据选择尚未尝试的方向，读完整实现后只在 writeScope 内修改。加载 experiment-runner skill。修改完成后调用 vcs_publish(message, paths)，paths 逐项列出本轮修改的精确文件。把 CLI payload 写入内核 scratch。宿主凭据只允许在同一个 bash 进程内捕获、消费并 unset，禁止输出。记录 task_id 后 timer 30 分钟。唤醒后检查任务与诊断结果：仍明显改善且未到内核 wait 上限才再次 timer；平台期或最终收割时停止任务，提取带 task_id、配置版本和数值证据的 findings。",
      "skills": ["experiment-runner"],
      "tools": ["read_file", "edit_file", "write_file", "grep", "glob", "bash", "spawn_sub_agent"],
      "capabilities": {"vcsPublish": {"remote": "origin"}},
      "hostRequirements": {"writePaths": ["~/.experiment-runner"]},
      "budgetPerRound": {"usd": 4, "turns": 80, "wallclockMin": 60}
    },
    "judge": {
      "context": "isolated",
      "prompt": "你是严格、保守、只认证据的实验评审。",
      "budgetPerRound": {"usd": 0.5, "turns": 10}
    },
    "pivoter": {
      "context": "isolated",
      "prompt": "只依据内嵌证据返回改变假设、证据源、实验阶段或评估结构的具体 directive，不做参数微调，不要求读写文件。",
      "inputs": ["ledger/directions.json", "ledger/findings.jsonl", "workspace:docs/prior-decisions.md"]
    },
    "finalizer": {
      "context": "isolated",
      "prompt": "按核心成果、最佳证据、未竟目标和后续建议生成收尾叙事。",
      "inputs": ["ledger/progress.json", "ledger/findings.jsonl", "ledger/directions.json"]
    }
  },
  "budgets": {
    "perRound": {"usd": 5},
    "lifetime": {"rounds": 20, "usd": 100}
  },
  "waitPolicy": {
    "selfTimer": {"maxParksPerRound": 12, "maxRoundElapsedMin": 360}
  },
  "health": {
    "staleWhen": "stale_count > 0",
    "onAbsent": "fail_stop",
    "onError": "fail_stop"
  },
  "writeScope": [
    "src/experiments/**",
    "configs/**"
  ],
  "roundIntervalMs": 0
}
```

对应的 `task_spec.draft.md` 只是人工部署/审阅附件，应至少列出：真实 skill 安装、外部状态
路径授权、Git remote 可推送、对应 CLI 可用性和首轮 dry-run 检查。它不会被
`loop create` 自动执行；任何运行时关键约束必须进入 Charter。
