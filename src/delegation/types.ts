/**
 * 子 Agent 委托系统类型定义
 */

import type { SharedBudget } from './budget.js';
import type { AgentStep, Toolset } from '../types.js';

// ---------------------------------------------------------------------------
// delegate_task 工具的入参（LLM 传入）
// ---------------------------------------------------------------------------

export interface DelegateTaskInput {
  /** 交给子 Agent 的任务描述（会作为 user message 传入） */
  task: string;

  /**
   * 补充背景上下文，会追加到 task 末尾。
   * 用于传递父 Agent 已知的关键信息，避免子 Agent 重复探索。
   */
  context?: string;

  /**
   * 子 Agent 启用的 toolset 列表。
   * 不传 → 继承父 Agent 的 enabledToolsets（自动排除 delegate_task 防止无限递归，
   *         除非 allow_delegation=true）。
   */
  toolsets?: Toolset[];

  /**
   * 子 Agent 的系统提示。
   * 定位：能力约束描述，而非角色扮演（如"只处理文件操作，不执行网络请求"）。
   * 不传 → 使用父 Agent 的 systemPrompt。
   */
  system_prompt?: string;

  /**
   * 子 Agent 最多消费的 iteration 次数。
   * 从共享 Budget 中扣减，不得超过当前剩余额度。
   * 默认值由父 Agent 的 delegation.defaultChildIterations 控制（默认 20）。
   */
  max_iterations?: number;

  /**
   * 子 Agent 使用的模型（可选，不传则继承父 Agent 的 provider.model）。
   * 常见用法：用便宜快速模型处理简单子任务。
   */
  model?: string;

  /**
   * 是否允许子 Agent 继续向下委托。
   * 默认 false（depth >= 1 时自动禁用 delegate_task 工具）。
   */
  allow_delegation?: boolean;
}

// ---------------------------------------------------------------------------
// 子 Agent 执行结果（结构化，返回给父 Agent）
// ---------------------------------------------------------------------------

export interface DelegateResult {
  /** 子任务是否成功完成（有最终 response 且未中断） */
  success: boolean;

  /** 子 Agent 的最终回复（压缩摘要，不包含中间工具调用） */
  summary: string;

  /** 本次委托消耗的 iteration 数 */
  iterations_used: number;

  /** 委托完成后共享预算的剩余额度 */
  budget_remaining: number;

  /** 子 Agent 实际调用过的工具名列表（去重） */
  tools_called: string[];

  /** 子 Agent 的 ID */
  agent_id: string;

  /** 子 Agent 的委托深度（从 1 开始） */
  depth: number;

  /** 如果执行失败，包含错误信息 */
  error?: string;
}

// ---------------------------------------------------------------------------
// 委托链内部 Context（注入到 ToolContext.metadata 供 delegate_task 工具使用）
// ---------------------------------------------------------------------------

/**
 * 事件冒泡回调——子 Agent 的事件通过这个接口向上冒泡到根 Agent。
 */
export interface DelegationBubbleCallbacks {
  onDelegateStart?: (task: string, childId: string, depth: number) => void;
  onDelegateComplete?: (childId: string, result: DelegateResult) => void;
  onChildToolStart?: (
    name: string,
    args: Record<string, unknown>,
    childId: string,
    depth: number,
  ) => void;
  onChildToolComplete?: (
    name: string,
    result: string,
    durationMs: number,
    childId: string,
    depth: number,
  ) => void;
  onChildStep?: (step: AgentStep, childId: string, depth: number) => void;
}

/**
 * 委托链上下文——由父 AgentRuntime 创建，注入到 ToolContext.metadata._delegation。
 * delegate_task 工具通过它感知当前深度、共享预算，并调用工厂方法创建子 Agent。
 */
export interface DelegationContext {
  /** 当前深度（root Agent = 0，子 Agent = 1，孙 Agent = 2 ...） */
  depth: number;

  /** 最大允许委托深度 */
  maxDepth: number;

  /** 跨整条链共享的 iteration 预算 */
  budget: SharedBudget;

  /** 根 Agent ID（用于日志追踪） */
  rootAgentId: string;

  /** 父 Agent ID */
  parentAgentId: string;

  /** 事件冒泡回调链 */
  bubbleCallbacks: DelegationBubbleCallbacks;

  /**
   * 工厂方法：创建并运行子 Agent。
   * 由 AgentRuntime 以闭包形式注入，避免 delegation/manager → agent 的循环依赖。
   */
  createChild: (input: DelegateTaskInput, childDepth: number) => Promise<DelegateResult>;
}

// ---------------------------------------------------------------------------
// 父 AgentRuntime 创建子 Agent 时的内部配置（不暴露到公共 API）
// ---------------------------------------------------------------------------

export interface ChildAgentInitOptions {
  /** 当前委托深度 */
  depth: number;
  /** 最大委托深度 */
  maxDepth: number;
  /** 共享预算引用 */
  sharedBudget: SharedBudget;
  /** 根 Agent ID */
  rootAgentId: string;
  /** 事件冒泡回调链（已包含整条链的汇聚） */
  bubbleCallbacks: DelegationBubbleCallbacks;
}
