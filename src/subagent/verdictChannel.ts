/**
 * verdictChannel — the shared output contract for "judge" sub-agents
 * (auto verify, auto drift, orchestration role reviewers).
 *
 * ## Why this exists
 *
 * Judge sub-agents are spawned with a REPLACING systemPrompt (their rubric),
 * so they never see DEFAULT_SUB_AGENT_SYSTEM_PROMPT. Historically each rubric
 * ended with "put a JSON code block in your last message" while
 * `SubAgentRunner` unconditionally injects a `return_result` tool whose own
 * description says the opposite ("call this instead of relying on your chat
 * text"). The judge therefore received two mutually exclusive instructions and
 * the runtime only parsed one of the two channels.
 *
 * When the model followed `return_result` with prose in `summary`, the verdict
 * failed to parse. That is not a silent pass — KernelLoop retries the whole
 * gate `autoGateMaxAttempts` times and then applies `autoGateFailurePolicy`
 * (default `checkpoint_pause`) — but each retry is a full judge run
 * (30 turns / $1 / up to 30 min), so a pure prompt-contract mismatch became an
 * expensive run-halting failure whose likelihood varies by model.
 *
 * ## The contract now
 *
 * 1. `VERDICT_OUTPUT_PROTOCOL` is appended to every judge rubric, making
 *    `return_result` the PRIMARY channel and the trailing JSON block an
 *    explicitly-blessed fallback. The two instructions no longer conflict.
 * 2. `readVerdictChannels()` yields both channels in priority order, so the
 *    gate parses whichever the model actually used.
 *
 * Adding `return_result` to a judge's `allowedTools` is NOT required — the
 * runner injects it on top of the resolved toolset (SubAgentRunner, "Always
 * give the sub-agent an explicit result channel").
 */

import type { SubAgentRecord } from './types.js'

/**
 * Appended to every judge rubric. Describes BOTH channels and names
 * `return_result` explicitly so the injected tool stops being an
 * unadvertised competing instruction.
 *
 * Callers pass the schema body (without fences) so each judge documents its
 * own verdict shape exactly once.
 */
export function buildVerdictOutputProtocol(schemaJson: string): string {
  return `\
输出（关键）——裁决必须通过下面两个通道之一给出，**首选第一个**：

1. **首选**：调用 \`return_result\` 工具一次，把裁决 JSON 原样放进 \`data\` 参数（\`summary\` 写一句话结论即可）。这是权威通道。
2. **备选**：若你没有调用 \`return_result\`，则必须在最后一条消息里只输出一个 JSON 代码块，不要有多余文字。

两种方式的 JSON schema 相同：
\`\`\`json
${schemaJson}
\`\`\`
不要同时使用两个通道输出不同内容。`
}

/**
 * Return the candidate verdict payloads carried by a terminal judge record, in
 * parse priority order:
 *
 *   1. `result.output` — the verbatim `return_result` data payload. Serialized
 *      back to JSON text so the existing text parsers handle it unchanged.
 *   2. `result.summary` — the accumulated last-text (or the runner-composed
 *      `summary + fenced data` string when return_result WAS called).
 *
 * Returns `[]` when the record carries neither, so callers can distinguish
 * "no usable result" from "result present but unparsable".
 */
export function readVerdictChannels(record: SubAgentRecord | null | undefined): string[] {
  const out: string[] = []
  const structured = record?.result?.output
  if (structured !== undefined && structured !== null) {
    // A judge may hand back either the object itself or a JSON string.
    if (typeof structured === 'string') {
      if (structured.trim()) out.push(structured)
    } else {
      try {
        out.push(JSON.stringify(structured))
      } catch {
        /* non-serializable payload — fall through to the text channel */
      }
    }
  }
  const summary = record?.result?.summary
  if (typeof summary === 'string' && summary.trim()) out.push(summary)
  return out
}

/**
 * Apply `parse` to each channel in priority order and return the first
 * non-null verdict. Keeps the "structured first, text fallback" policy in one
 * place so all three judges behave identically.
 */
export function parseFromVerdictChannels<T>(
  record: SubAgentRecord | null | undefined,
  parse: (text: string) => T | null,
): T | null {
  for (const channel of readVerdictChannels(record)) {
    const parsed = parse(channel)
    if (parsed) return parsed
  }
  return null
}
