# 文档索引

`docs/` 下的全部文件都在这份索引里。新增文档请同时补一行——**残缺的索引比没有索引更糟**，因为你无法判断它漏了什么。

## 目录结构

```
docs/
  自动模式/      auto / auto_orch / simple_auto 的设计与调度
  图循环/        Graph Loop 运行时、Distill、管理面板
  知识系统/      experience · principle · physical anchor
  机器人模式/    robotics 模式设计与场景手册
  工作流/        workflow 系统
  参考手册/      配置、权限、提示词等查阅型文档
  architecture/  as-built 架构参考（英文原名，被代码注释引用）
  reviews/       历次代码审查与审计（英文原名，被代码注释引用）
  reports/       对外报告
  testing/       测试计划与审计
  examples/      可运行示例
```

> `architecture/` 与 `reviews/` 保留英文文件名：这两处被 20 多处代码注释按路径引用，
> 且审查报告是带日期的历史快照，改名收益小、断链风险大。

---

## 入门

- [架构总览（as-built）](architecture/meta-agent-architecture.md)
- [配置参考](参考手册/配置参考.md)
- [权限配置](参考手册/权限配置.md)

## 自动模式

- [自动模式设计](自动模式/自动模式设计.md)
- [编排模式设计](自动模式/编排模式设计.md)
- [自动调度器](自动模式/自动调度器.md) — *同时随 npm 包发布*
- [闭环控制：验证 · 漂移/学习 · 检查点（2026-06-17）](自动模式/闭环控制-验证与漂移-2026-06-17.md)

## 图循环（Graph Loop）

**使用**

- [图循环使用指南](图循环/图循环使用指南.md)
- [图代理执行底座与替换契约](图循环/图代理执行底座.md)
- [支持包：证据、外部契约与运维视图](图循环/支持包-证据与外部契约.md)

**设计与路线**

- [持久化图循环 v2 — 设计与实现映射](图循环/持久化图循环设计-v2.md)
- [管理面板接口设计](图循环/管理面板接口设计.md)
- [定位与下一阶段演进重点（2026-07-21）](图循环/定位与演进重点-2026-07-21.md)
- [P1 路线：面向多领域长程循环（2026-07-21）](图循环/P1路线-多领域长程循环-2026-07-21.md)

**Distill**

- [Distill 接入与语义复核收敛方案（2026-07-31）](图循环/Distill接入与复核收敛方案-2026-07-31.md)
- [Distill 语义复核分级方案（2026-07-28）](图循环/Distill语义复核分级方案-2026-07-28.md)

## 知识系统

- [轨迹学习 Reviewer 模式设计](知识系统/轨迹学习Reviewer模式设计.md)
- [轨迹数据利用与进化算法选型](知识系统/轨迹数据利用与进化算法选型.md) — 优化对象分层、算法边界、reward 设计的主文档
- [自进化实施计划](知识系统/自进化实施计划.md) — 六阶段任务拆解、里程碑与中止条件
- [知识系统 v1：只跑 experience + anchor](知识系统/知识系统v1-经验与锚点.md)
- [知识召回（读侧）对齐方案](知识系统/知识召回对齐方案.md)
- [物理锚点接入方案](知识系统/物理锚点接入方案.md)
- [原则机制改进方案](知识系统/原则机制改进方案.md)

## 机器人模式

- [场景手册：loop / compact / prompt 全行为示例（2026-06-12）](机器人模式/场景手册-循环与压缩与提示词-2026-06-12.md)
- [机器人模式设计 v2 — 已归档](机器人模式/机器人模式设计-v2-已归档.md)
- [机器人模式设计 v1 — 已归档](机器人模式/机器人模式设计-v1-已归档.md)

## 工作流

- [工作流系统设计（as-built）](工作流/工作流系统设计.md)

## 参考手册

- [配置参考（config.json）](参考手册/配置参考.md)
- [权限配置](参考手册/权限配置.md)
- [提示词演进记录](参考手册/提示词演进记录.md)

## 架构

- [架构总览（as-built）](architecture/meta-agent-architecture.md)
- [沙箱架构方案（SVG）](architecture/sandbox_architecture_plan.svg)
- [P0 工作区边界与恢复完整性整改（2026-07-10）](architecture/p0-workspace-jail-and-resume-integrity-plan-2026-07-10.md)

## 测试

- [补充测试计划](testing/TEST_PLAN.md)
- [回归验证 + 测试审计](testing/TEST_AUDIT.md)

## 审查与审计

按时间倒序。

### 2026-08

- [meta-agent 自进化方案审查（2026-08-25）](reviews/meta-agent-自进化方案审查-2026-08-25.md) — 仅批准 E0；评测、因果归因与实施顺序的阻断项
- [代码审查：逻辑 bug、资源管理、健壮性（2026-08-12）](reviews/code-review-2026-08-12.md)
- [终端 / 显示层审查（2026-08-12）](reviews/code-review-terminal-2026-08-12.md)
- [Windows 部署问题清单（2026-08-12）](reviews/windows-porting-review-2026-08-12.md)

### 2026-07

- [代码评审（2026-07-26）](reviews/code-review-2026-07-26.md)
- [Graph Loop 评审（2026-07-26）](reviews/graph-loop-review-2026-07-26.md)
- [稳定性 + 全流程 Prompt 链路审核（2026-07-27）](reviews/code-review-stability-and-prompts-2026-07-27.md)
- [Timeout 全流程审核（2026-07-27）](reviews/timeout-audit-2026-07-27.md)
- [Graph Loop 节点 Token 消耗审计（2026-07-27）](reviews/graph-loop-token-cost-audit-2026-07-27.md)
- [Graph Loop 复审（2026-07-21）](reviews/graph-loop-audit-2026-07-21.md)
- [Graph Loop 审查与优化（2026-07-20）](reviews/graph-loop-audit-and-remediation-2026-07-20.md)
- [Graph Loop 全面审核（2026-07-19）](reviews/graph-loop-audit-2026-07-19.md)
- [Distill 产出不可运行图的根因分析（2026-07-19）](reviews/distill-root-cause-analysis-2026-07-19.md)
- [Auto / simple_auto 双模式审核（2026-07-07）](reviews/code-review-auto-simple-auto-2026-07-07.md)
- [Robotics / agentic 双模式审核（2026-07-07）](reviews/code-review-robotics-agentic-2026-07-07.md)
- [SubAgent 与隔离机制审核 + 性能方案（2026-07-07）](reviews/code-review-subagent-isolation-2026-07-07.md)
- [auto_orch 模式代码与功能审查（2026-07-03）](reviews/auto-orch-code-review-2026-07-03.md)

### 2026-06

- [代码审查（2026-06-22）](reviews/code-review-2026-06-22.md)
- [架构健壮性审查：低耦合 / 高内聚 / 可扩展（2026-06-18）](reviews/architecture-review-2026-06-18.md)
- [多智能体架构审查（2026-06-18）](reviews/multi-agent-architecture-review-2026-06-18.md)
- [多智能体三处高危整改方案（2026-06-18）](reviews/multi-agent-high-severity-remediation-plan-2026-06-18.md)
- [模式代码审查：robotics / agentic / auto（2026-06-18）](reviews/code-review-modes-2026-06-18.md)
- [并发子代理启用方案（2026-06-18）](reviews/enable-concurrent-subagents-plan-2026-06-18.md)
- [全面代码评审（2026-06-16）](reviews/CODE_REVIEW_FULL_2026-06-16.md)
- [长周期目标一致性审查（2026-06-12）](reviews/goal-drift-noise-review-2026-06-12.md)
- [健壮性与稳定性审查（2026-06-11）](reviews/code-review-robustness-2026-06-11.md)
- [性能审查（2026-06-11）](reviews/perf-review-2026-06-11.md)
- [长期稳定运行视角审核（2026-06-10）](reviews/code-review-stability-2026-06-10.md)

### 更早

- [代码审查 · 0.8.11](reviews/CODE_REVIEW_0.8.11.md)
- [全面代码评审（2026-05-31）](reviews/CODE_REVIEW_2026-05-31.md)
- [全量代码评审（2026-05-29）](reviews/CODE_REVIEW_2026-05-29.md)
- [长跑稳定性与内存评审（2026-05-29）](reviews/STABILITY_REVIEW_2026-05-29.md)
- [历史遗留代码评审](reviews/CODE_REVIEW.md)

## 报告

- [架构技术报告](reports/REPORT_ARCHITECTURE.md)
- [功能报告](reports/REPORT_FUNCTIONAL.md)
- [评比汇报材料](reports/agent-competition-report.md)

## 示例

- [x1 loop 示例](examples/x1_loop.md)
