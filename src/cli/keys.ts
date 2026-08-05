/**
 * cli/keys — API-key hygiene: sanitising, validating and asserting that a
 * provider credential is actually configured before a session starts.
 *
 * Extracted from cli/index.ts.
 */
import { RuntimeEnv } from '../infra/env/RuntimeEnv.js'
import { detectProvider } from '../core/config.js'
import { loadModelConfig } from '../core/config/ConfigService.js'
import { bold, cyan, dim, red, yellow } from './term.js'
import type { CliOptions } from './args.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip surrounding quotes and non-ASCII chars that break HTTP headers */
function sanitizeKey(key: string): string {
  // Remove Unicode curly quotes, regular quotes, and leading/trailing whitespace
  return key.replace(/^[“”‘’"'\s]+|[“”‘’"'\s]+$/g, '')
}

/**
 * Sanitize and validate a single key string.
 * Returns the cleaned key, or exits the process on invalid characters.
 */
function validateKey(raw: string, label: string): string {
  const clean = sanitizeKey(raw)
  if (clean !== raw) {
    console.warn(yellow(`⚠  ${label} 含有首尾引号/空白，已自动清除。`))
  }
  for (let i = 0; i < clean.length; i++) {
    if (clean.charCodeAt(i) > 255) {
      console.error(red(
        `Error: ${label} 包含无效字符（位置 ${i}, ` +
        `U+${clean.charCodeAt(i).toString(16).toUpperCase()}）。` +
        `请重新导出 API key，不要包含引号。`,
      ))
      process.exit(1)
    }
  }
  return clean
}

/**
 * Sanitize all provider API key env vars in-place so detectProvider()
 * reads clean values without routing interference.
 * Also handles the explicit --api-key CLI flag.
 *
 * Rule: env-var keys stay in process.env — detectProvider() reads them
 * directly for correct provider + baseURL selection.
 * Only an explicit --api-key flag is forwarded as cfg.apiKey.
 */
export function sanitizeEnvKeys(): void {
  for (const k of ['ZHIPU_API_KEY', 'ZAI_API_KEY', 'GLM_API_KEY', 'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'QWEN_API_KEY'] as const) {
    const raw = process.env[k]
    if (raw) process.env[k] = validateKey(raw, k)
  }
}

/**
 * Return an explicit --api-key value for cfg.apiKey injection.
 * Returns undefined when the key came only from env vars — in that case
 * detectProvider() will pick up the correct provider and baseURL automatically.
 */
export function resolveExplicitApiKey(opts: CliOptions): string | undefined {
  if (!opts.apiKey) return undefined
  return validateKey(opts.apiKey, '--api-key')
}

export function assertApiKeyConfigured(opts: CliOptions): void {
  const explicitApiKey = resolveExplicitApiKey(opts)
  if (explicitApiKey) opts.apiKey = explicitApiKey
  // Mirror resolveConfig()'s precedence (file > CLI/env): the global config file
  // (~/.meta-agent/config.json) may supply apiKey / baseURL / model. Without
  // folding it in here, a valid config-file key would be wrongly rejected at the
  // startup gate even though the session would later resolve it fine.
  const file = loadModelConfig({ projectDir: opts.workspace })
  const detected = detectProvider({
    apiKey:  file.apiKey  ?? explicitApiKey,
    baseURL: file.baseURL ?? opts.baseUrl,
    model:   file.mainModel ?? opts.model,
  })
  if (detected.apiKey) return

  console.error(
    red('Error: API key is required before starting a session.') + '\n' +
    dim('Set one of these environment variables, or pass --api-key:') + '\n' +
    `  ${cyan('export ZHIPU_API_KEY="..."')} ${dim('(default provider — glm-5.2)')}\n` +
    `  ${cyan('export DEEPSEEK_API_KEY="sk-..."')}\n` +
    `  ${cyan('export QWEN_API_KEY="sk-..."')}\n` +
    `  ${cyan('export ANTHROPIC_API_KEY="sk-..."')}\n` +
    `  ${cyan('meta-agent --api-key sk-... "your prompt"')}\n`,
  )
  process.exit(1)
}

