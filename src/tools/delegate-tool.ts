/**
 * delegate_task 工具
 *
 * 设计原则（来自 Anthropic multi-agent 文章）：
 *  - Subagent = 上下文隔离工具，不是角色扮演
 *  - parallelSafe: true → LLM 同一响应中的多次 delegate_task 调用并发执行（Fan-out）
 *  - 结果只返回压缩摘要，不把子 Agent 的中间轨迹塞入父 Agent 上下文
 *  - 停止条件三重保险：SharedBudget + max_iterations + MAX_DEPTH
 */

import { registerTool } from './registry.js';
import type { DelegationContext, DelegateResult } from '../delegation/types.js';

// delegate_task 在父 Agent ToolContext.metadata 里存放的 key
export const DELEGATION_CTX_KEY = '_delegation' as const;

registerTool({
  name: 'delegate_task',
  toolset: 'delegation',
  parallelSafe: true,   // ← 允许同一 LLM 响应中并发 fan-out
  emoji: '🤝',
  maxResultSizeChars: 8_000,
  definition: {
    name: 'delegate_task',
    description: `将一个子任务委托给独立的子 Agent 执行。子 Agent 有自己独立的上下文窗口，
默认继承当前 Agent 的全部工具集（可通过 toolsets 覆盖），
完成后只返回压缩摘要，不会污染当前对话的上下文。

适合场景：
- 需要大量文件搜索 / 日志扫描，不希望污染主线上下文
- 可以并行探索的独立子问题（在一次回复中多次调用 delegate_task 即可并发执行）
- 任务边界清晰、有明确输出的子任务

注意：
- 所有 Agent（父+子）共享总 iteration 预算，请合理分配 max_iterations
- 子 Agent 默认不能再次委托（防止无限递归），除非设置 allow_delegation=true`,
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '交给子 Agent 的完整任务描述。要清晰、自包含——子 Agent 看不到当前对话历史。',
        },
        context: {
          type: 'string',
          description: '补充背景信息（如已知的文件路径、约束条件等），追加到 task 末尾。',
        },
        toolsets: {
          type: 'array',
          items: { type: 'string' },
          description: '子 Agent 可用的 toolset 列表。不传则继承父 Agent 的全部工具集。',
        },
        system_prompt: {
          type: 'string',
          description: '子 Agent 的系统提示（能力/范围约束描述，不是角色扮演）。不传则继承父 Agent。',
        },
        max_iterations: {
          type: 'integer',
          description: '子 Agent 最多消耗的 iteration 数（从共享预算中扣减）。默认 20。',
        },
        model: {
          type: 'string',
          description: '子 Agent 使用的模型，不传则与父 Agent 一致。可用便宜模型处理简单子任务。',
        },
        allow_delegation: {
          type: 'boolean',
          description: '是否允许子 Agent 继续向下委托。默认 false。',
        },
      },
      required: ['task'],
    },
  },

  handler: async (args, context) => {
    // -----------------------------------------------------------------------
    // 1. 从 ToolContext 中取出委托上下文
    // -----------------------------------------------------------------------
    const delegationCtx = context.metadata?.[DELEGATION_CTX_KEY] as DelegationContext | undefined;

    if (!delegationCtx) {
      return JSON.stringify({
        success: false,
        summary: '',
        error: 'delegate_task: No delegation context found. AgentRuntime must inject _delegation into ToolContext.',
        iterations_used: 0,
        budget_remaining: 0,
        tools_called: [],
        agent_id: 'unknown',
        depth: 0,
      } satisfies DelegateResult);
    }

    // -----------------------------------------------------------------------
    // 2. 检查深度限制
    // -----------------------------------------------------------------------
    const childDepth = delegationCtx.depth + 1;
    if (childDepth > delegationCtx.maxDepth) {
      return JSON.stringify({
        success: false,
        summary: '',
        error: `delegate_task: Max delegation depth (${delegationCtx.maxDepth}) exceeded at depth ${delegationCtx.depth}.`,
        iterations_used: 0,
        budget_remaining: delegationCtx.budget.remaining,
        tools_called: [],
        agent_id: 'blocked',
        depth: childDepth,
      } satisfies DelegateResult);
    }

    // -----------------------------------------------------------------------
    // 3. 检查预算
    // -----------------------------------------------------------------------
    if (delegationCtx.budget.exhausted) {
      return JSON.stringify({
        success: false,
        summary: '',
        error: 'delegate_task: Shared iteration budget exhausted.',
        iterations_used: 0,
        budget_remaining: 0,
        tools_called: [],
        agent_id: 'blocked',
        depth: childDepth,
      } satisfies DelegateResult);
    }

    // -----------------------------------------------------------------------
    // 4. 触发 onDelegateStart 冒泡
    // -----------------------------------------------------------------------
    const task = args['task'] as string;
    const taskInput = {
      task,
      context: args['context'] as string | undefined,
      toolsets: args['toolsets'] as string[] | undefined,
      system_prompt: args['system_prompt'] as string | undefined,
      max_iterations: args['max_iterations'] as number | undefined,
      model: args['model'] as string | undefined,
      allow_delegation: args['allow_delegation'] as boolean | undefined,
    };

    delegationCtx.bubbleCallbacks.onDelegateStart?.(task, `child@depth${childDepth}`, childDepth);

    // -----------------------------------------------------------------------
    // 5. 调用工厂方法创建并运行子 Agent
    // -----------------------------------------------------------------------
    let result: DelegateResult;
    try {
      result = await delegationCtx.createChild(taskInput, childDepth);
    } catch (err) {
      result = {
        success: false,
        summary: '',
        error: `Child agent threw: ${(err as Error).message}`,
        iterations_used: 0,
        budget_remaining: delegationCtx.budget.remaining,
        tools_called: [],
        agent_id: 'error',
        depth: childDepth,
      };
    }

    // -----------------------------------------------------------------------
    // 6. 触发 onDelegateComplete 冒泡
    // -----------------------------------------------------------------------
    delegationCtx.bubbleCallbacks.onDelegateComplete?.(result.agent_id, result);

    // -----------------------------------------------------------------------
    // 7. 返回结构化结果（JSON 字符串 → LLM 可读）
    // -----------------------------------------------------------------------
    return formatDelegateResultForLLM(result);
  },
});

// ---------------------------------------------------------------------------
// 格式化结果供 LLM 消费
// ---------------------------------------------------------------------------

function formatDelegateResultForLLM(result: DelegateResult): string {
  if (!result.success) {
    return [
      `❌ 子任务执行失败 (depth=${result.depth}, agent=${result.agent_id})`,
      `错误：${result.error ?? 'unknown'}`,
      `预算剩余：${result.budget_remaining}`,
    ].join('\n');
  }

  return [
    `✅ 子任务完成 (depth=${result.depth}, agent=${result.agent_id})`,
    `消耗 ${result.iterations_used} iterations，预算剩余 ${result.budget_remaining}`,
    result.tools_called.length > 0
      ? `使用工具：${result.tools_called.join(', ')}`
      : '未使用工具',
    '',
    '--- 结果摘要 ---',
    result.summary,
  ].join('\n');
}
