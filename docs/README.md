# Documentation Index

Everything under `docs/` is listed here. If you add a file, add a line — a
partial index is worse than none, because you cannot tell what it is missing.

Layout:

```
docs/
  *.md              guides and design notes
  architecture/     as-built architecture references
  reviews/          code reviews, audits, remediation plans
  reports/          written-up reports
  testing/          test plans and audits
  examples/         worked examples
```

---

## Start here

- [Architecture overview (as-built)](architecture/meta-agent-architecture.md)
- [Configuration reference (`config.json`)](config-reference.md)
- [Permissions](permissions.md)

## Guides

- [Graph Loop usage guide](loop-runtime-guide.md)
- [Auto Scheduler](auto-scheduler.md) — *also shipped in the npm package*
- [`graph_agent` execution substrate and replacement contract](graph-agent-executor.md)
- [Graph Loop support packs: evidence, external contracts, operator views](graph-loop-support-packs.md)
- [Robotics scenario handbook: loop / compact / prompt behaviour](robotics-scenarios-loop-compact-prompt-2026-06-12.md)
- [Worked example: x1 loop](examples/x1_loop.md)

## Design notes

### Auto / orchestration

- [Auto mode design](auto-mode-design.md)
- [Auto-orch mode design](auto-orch-design.md)
- [Auto closed-loop control: Verify · Drift/Learn · Checkpoint](auto-loop-engineering-2026-06-17.md)

### Graph Loop

- [Durable Graph Loop v2 — design and implementation map](loop-durable-graph-runtime-plan.md)
- [Graph Loop positioning and next-phase evolution](graph-loop-positioning-and-roadmap-2026-07-21.md)
- [Graph Loop P1 roadmap: multi-domain long-running loops](graph-loop-p1-roadmap-2026-07-21.md)
- [Loop admin panel — API design](loop-admin-api-design.md)
- [Distill intake and semantic-review convergence](distill-intake-and-review-convergence-2026-07-31.md)
- [Distill semantic severity tiers (2b allowlist draft)](distill-semantic-severity-2026-07-28.md)

### Knowledge system

- [Knowledge v1 (trimmed): experience + anchor only](knowledge-v1-experience-anchor.md)
- [Knowledge recall (read side): aligning anchor / principle with experience](knowledge-recall-plan.md)
- [Physical Anchor integration plan](anchor-integration-plan.md)
- [Principle mechanism improvements](principle-mechanism-improvement.md)

### Other subsystems

- [Workflow system design (as-built)](workflow-system-design.md)
- [Prompt evolution log](prompt-optimization-plan.md)
- [Sandbox architecture plan (SVG)](architecture/sandbox_architecture_plan.svg)
- [P0 workspace jail and resume-integrity remediation](architecture/p0-workspace-jail-and-resume-integrity-plan-2026-07-10.md)
- [Robotics mode design v2 — archived](robotics-mode-design-v2.md)
- [Robotics mode design v1 — archived](robotics-mode-design.md)

## Testing

- [Supplementary test plan](testing/TEST_PLAN.md)
- [Regression verification + test audit](testing/TEST_AUDIT.md)

## Reviews and audits

Newest first.

### 2026-08

- [Code review — logic bugs, resource management, robustness (2026-08-12)](reviews/code-review-2026-08-12.md)
- [Terminal / display layer review (2026-08-12)](reviews/code-review-terminal-2026-08-12.md)
- [Windows porting issues (2026-08-12)](reviews/windows-porting-review-2026-08-12.md)

### 2026-07

- [Code review (2026-07-26)](reviews/code-review-2026-07-26.md)
- [Graph Loop review (2026-07-26)](reviews/graph-loop-review-2026-07-26.md)
- [Stability + full prompt-chain review (2026-07-27)](reviews/code-review-stability-and-prompts-2026-07-27.md)
- [Timeout audit, end to end (2026-07-27)](reviews/timeout-audit-2026-07-27.md)
- [Graph Loop node token-cost audit (2026-07-27)](reviews/graph-loop-token-cost-audit-2026-07-27.md)
- [Graph Loop re-audit (2026-07-21)](reviews/graph-loop-audit-2026-07-21.md)
- [Graph Loop audit and remediation (2026-07-20)](reviews/graph-loop-audit-and-remediation-2026-07-20.md)
- [Graph Loop audit (2026-07-19)](reviews/graph-loop-audit-2026-07-19.md)
- [Distill unrunnable-graph root-cause analysis (2026-07-19)](reviews/distill-root-cause-analysis-2026-07-19.md)
- [Auto / simple_auto dual-mode audit (2026-07-07)](reviews/code-review-auto-simple-auto-2026-07-07.md)
- [Robotics / agentic dual-mode audit (2026-07-07)](reviews/code-review-robotics-agentic-2026-07-07.md)
- [SubAgent and isolation audit + perf plan (2026-07-07)](reviews/code-review-subagent-isolation-2026-07-07.md)
- [auto_orch mode code and functional review (2026-07-03)](reviews/auto-orch-code-review-2026-07-03.md)

### 2026-06

- [Code review (2026-06-22)](reviews/code-review-2026-06-22.md)
- [Architecture robustness review — coupling / cohesion / extensibility (2026-06-18)](reviews/architecture-review-2026-06-18.md)
- [Multi-agent architecture review (2026-06-18)](reviews/multi-agent-architecture-review-2026-06-18.md)
- [Multi-agent — three high-severity remediation plan (2026-06-18)](reviews/multi-agent-high-severity-remediation-plan-2026-06-18.md)
- [Mode code review: robotics / agentic / auto (2026-06-18)](reviews/code-review-modes-2026-06-18.md)
- [Concurrent sub-agents enablement plan (2026-06-18)](reviews/enable-concurrent-subagents-plan-2026-06-18.md)
- [Full code review (2026-06-16)](reviews/CODE_REVIEW_FULL_2026-06-16.md)
- [Long-horizon goal-consistency review (2026-06-12)](reviews/goal-drift-noise-review-2026-06-12.md)
- [Runtime robustness review (2026-06-11)](reviews/code-review-robustness-2026-06-11.md)
- [Performance review (2026-06-11)](reviews/perf-review-2026-06-11.md)
- [Runtime stability review (2026-06-10)](reviews/code-review-stability-2026-06-10.md)

### Earlier

- [Code review · 0.8.11](reviews/CODE_REVIEW_0.8.11.md)
- [Full code review (2026-05-31)](reviews/CODE_REVIEW_2026-05-31.md)
- [Full code review (2026-05-29)](reviews/CODE_REVIEW_2026-05-29.md)
- [Long-run stability and memory review (2026-05-29)](reviews/STABILITY_REVIEW_2026-05-29.md)
- [Legacy code review](reviews/CODE_REVIEW.md)

## Reports

- [Architecture technical report](reports/REPORT_ARCHITECTURE.md)
- [Functional report](reports/REPORT_FUNCTIONAL.md)
- [Agent competition report](reports/agent-competition-report.md)
