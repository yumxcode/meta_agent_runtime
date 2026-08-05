/**
 * cli/hardware — robotics hardware-profile selection and creation flows.
 *
 * Extracted from cli/index.ts.
 */
import * as readline from 'node:readline'
import { createInterface } from 'node:readline'
import { HardwareProfile } from '../robotics/HardwareProfile.js'
import { resolveTemplate } from './hardwareTemplate.js'
import type { ProfileTemplate, ProfilePreset } from './hardwareTemplate.js'
import { bold, cyan, dim, gray, green, red, yellow, isTTY } from './term.js'
import { askQuestion } from './prompts.js'

/**
 * Interactively select or create a hardware profile for a robotics session.
 * Loads the active ProfileTemplate (project → global → default).
 * Returns the profile name that was selected/created, plus formatted text for prompt injection.
 *
 * @param existingRl - Pass the REPL's readline interface when calling from inside the REPL
 *   loop so we never have two readline instances sharing stdin simultaneously.  When omitted
 *   (e.g. the initial call before the loop starts) a new interface is created and closed.
 */
export async function selectHardwareProfile(
  hp: HardwareProfile,
  projectDir?: string,
  existingRl?: readline.Interface,
): Promise<{ name: string; profileText: string }> {
  const [profiles, template] = await Promise.all([
    hp.list(),
    resolveTemplate(projectDir),
  ])

  // Re-use the caller's readline interface if provided — creating a second interface
  // on the same stdin while one is already active causes both to fight over input and
  // the wizard exits immediately without reading any keystrokes.
  const ownRl = existingRl == null
  if (ownRl) process.stdin.resume()
  const rl = existingRl ?? createInterface({ input: process.stdin, output: process.stdout, terminal: isTTY })

  try {
    if (profiles.length === 0) {
      // No profiles — must create one
      console.log(
        `\n${yellow('⚠  暂无硬件配置文件')}\n` +
        `robotics 模式需要绑定一个硬件配置。\n` +
        `请填写以下信息创建第一个配置（* 为必填，其余直接回车跳过）：\n`,
      )
      return createHardwareProfile(rl, hp, template)
    }

    if (profiles.length === 1) {
      // Single profile — auto-select with confirmation
      const name = profiles[0]!
      const profileText = await hp.formatForPrompt(name)
      console.log(`\n${dim('检测到唯一硬件配置:')} ${cyan(name)}`)
      const confirm = await askQuestion(rl, `使用此配置？[Y/n] `)
      if (confirm.toLowerCase() === 'n') {
        // Offer to create a new one instead
        const createNew = await askQuestion(rl, `新建一个配置？[y/N] `)
        if (createNew.toLowerCase() === 'y') {
          return createHardwareProfile(rl, hp, template)
        }
        console.log(dim('已跳过，将在无硬件约束下运行。'))
        return { name: '', profileText: '' }
      }
      console.log(green(`✓ 已绑定硬件配置: ${name}\n`))
      return { name, profileText }
    }

    // Multiple profiles — show numbered list
    console.log(`\n${bold('选择此会话使用的硬件配置:')}\n`)
    profiles.forEach((name, i) => {
      console.log(`  ${cyan(String(i + 1))}.  ${name}`)
    })
    console.log(`  ${cyan(String(profiles.length + 1))}.  ${dim('新建配置')}`)
    console.log(`  ${cyan('0')}.  ${dim('跳过（不绑定硬件）')}\n`)

    const answer = await askQuestion(rl, `请输入序号 [0-${profiles.length + 1}]: `)
    const idx = parseInt(answer, 10)

    if (idx === 0 || isNaN(idx)) {
      console.log(dim('\n已跳过硬件绑定。\n'))
      return { name: '', profileText: '' }
    }

    if (idx === profiles.length + 1) {
      return createHardwareProfile(rl, hp, template)
    }

    if (idx >= 1 && idx <= profiles.length) {
      const name = profiles[idx - 1]!
      const profileText = await hp.formatForPrompt(name)
      console.log(green(`\n✓ 已绑定硬件配置: ${name}\n`))
      return { name, profileText }
    }

    console.log(yellow('无效输入，跳过硬件绑定。'))
    return { name: '', profileText: '' }
  } finally {
    // Only close if we created the interface ourselves
    if (ownRl) rl.close()
  }
}

/**
 * Guided wizard to create a new HardwareProfileData and persist it.
 * Uses a ProfileTemplate so field prompts, defaults and presets are configurable.
 * Returns name + formatted text.
 */
async function createHardwareProfile(
  rl: readline.Interface,
  hp: HardwareProfile,
  template: ProfileTemplate,
): Promise<{ name: string; profileText: string }> {
  console.log(`\n${bold('新建硬件配置')} ${dim('(* 必填，直接回车使用括号内默认值)')}\n`)

  // ── Step 1: optional preset selection ──────────────────────────────────────
  const presets = template.presets ?? []
  let presetDefaults: Record<string, unknown> = {}

  if (presets.length > 0) {
    console.log(`${dim('可选预设（选择后自动填充字段，仍可逐项覆盖）:')}\n`)
    presets.forEach((p, i) => console.log(`  ${cyan(String(i + 1))}.  ${p.label}`))
    // Always show an explicit "custom" option so it's clear you can type freely
    const customIdx = presets.length + 1
    console.log(`  ${cyan(String(customIdx))}.  ${dim('自定义（手动填写所有字段）')}`)
    console.log()
    const choice = await askQuestion(rl, `选择预设 [1-${customIdx}，回车跳过]: `)
    const idx = parseInt(choice, 10)
    if (!isNaN(idx) && idx >= 1 && idx <= presets.length) {
      presetDefaults = (presets[idx - 1] as ProfilePreset).defaults as Record<string, unknown>
      console.log(dim(`\n已载入预设「${presets[idx - 1]!.label}」，可逐字段覆盖。\n`))
    } else if (!isNaN(idx) && idx === customIdx) {
      console.log(dim('\n自定义模式：请逐字段手动填写。\n'))
      // presetDefaults stays empty — all fields filled from scratch
    }
    // else Enter / invalid → no preset, manual fill (same as custom)
  }

  // ── Step 2: field-by-field input driven by template ────────────────────────
  const collected: Record<string, unknown> = { ...presetDefaults }

  for (const field of template.fields) {
    const type     = field.type ?? 'text'
    const required = field.required ?? false
    const presetVal = presetDefaults[field.key]

    if (type === 'kv') {
      // key:value pairs, blank to finish
      const existing = (presetVal as Record<string, string> | undefined) ?? {}
      const kv: Record<string, string> = { ...existing }

      if (Object.keys(existing).length > 0) {
        console.log(dim(`  ${field.label} (已预填，继续添加或直接回车结束):`))
        for (const [k, v] of Object.entries(existing)) {
          console.log(dim(`    ${k}: ${v}`))
        }
      } else {
        const hint = field.hint ? ` (${dim(field.hint)})` : ''
        console.log(dim(`  ${field.label}${hint}:`))
      }
      for (;;) {
        const entry = await askQuestion(rl, `    > `)
        if (!entry) break
        const colonIdx = entry.indexOf(':')
        if (colonIdx < 1) { console.log(yellow('    格式应为 key:value，已跳过')); continue }
        kv[entry.slice(0, colonIdx).trim()] = entry.slice(colonIdx + 1).trim()
      }
      if (Object.keys(kv).length === 0) kv['limit'] = 'unset'
      collected[field.key] = kv

    } else if (type === 'csv') {
      const hint = field.hint ? ` (${dim(field.hint)})` : ''
      const prefix = required ? `${red('*')} ` : '  '
      const raw = await askQuestion(rl, `${prefix}${field.label}${hint}: `)
      const arr = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : []
      collected[field.key] = arr.length > 0 ? arr : undefined

    } else {
      // plain text — show preset default in brackets if available
      const defVal = typeof presetVal === 'string' ? presetVal : (field.default ?? '')
      const bracket = defVal ? ` ${dim(`[${defVal}]`)}` : ''
      const hint    = field.hint && !defVal ? ` ${dim(`(如 ${field.hint})`)}` : ''
      const prefix  = required ? `${red('*')} ` : '  '

      let value: string
      for (;;) {
        value = await askQuestion(rl, `${prefix}${field.label}${hint}${bracket}: `)
        if (!value && defVal)  { value = defVal; break }
        if (!value && required) { console.log(yellow(`    「${field.label}」为必填项，不能为空`)); continue }
        break
      }
      collected[field.key] = value || undefined
    }
  }

  // ── Step 3: validate name ───────────────────────────────────────────────────
  const name = collected['name'] as string | undefined
  if (!name) {
    console.log(yellow('\n名称为空，跳过硬件绑定。\n'))
    return { name: '', profileText: '' }
  }

  // ── Step 4: build & persist ─────────────────────────────────────────────────
  await hp.write({
    name,
    platform:     (collected['platform']     as string) || 'unknown',
    compute:      (collected['compute']      as string) || 'unknown',
    os:           (collected['os']           as string) || undefined,
    actuators:    (collected['actuators']    as string) || undefined,
    sensors:      (collected['sensors']      as string) || undefined,
    safetyLimits: (collected['safetyLimits'] as Record<string, string>) ?? { limit: 'unset' },
    knownIssues:  (collected['knownIssues']  as string[]) || undefined,
    notes:        buildExtraNotes(collected, template),
  })

  console.log(green(`\n✓ 硬件配置 "${name}" 已保存并绑定到本会话。\n`))
  const profileText = await hp.formatForPrompt(name)
  return { name, profileText }
}

/**
 * Any fields in the template that aren't native HardwareProfileData keys
 * are serialised as "key: value" lines and appended to notes.
 */
const NATIVE_KEYS = new Set([
  'name','platform','compute','os','actuators','sensors','safetyLimits','knownIssues','notes',
])
function buildExtraNotes(
  collected: Record<string, unknown>,
  template: ProfileTemplate,
): string | undefined {
  const baseNotes = (collected['notes'] as string | undefined) ?? ''
  const extras: string[] = []
  for (const field of template.fields) {
    if (NATIVE_KEYS.has(field.key)) continue
    const v = collected[field.key]
    if (v !== undefined && v !== '' && v !== null) {
      extras.push(`${field.label}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    }
  }
  const combined = [baseNotes, ...extras].filter(Boolean).join('\n')
  return combined || undefined
}

/** Build the hardware profile block for injection into the system prompt */
export function buildHardwareSystemPrompt(profileText: string): string {
  return [
    `## 当前会话硬件配置 (HARDWARE PROFILE — SESSION-BOUND)`,
    ``,
    `以下硬件规格在本会话中固定，所有代码、参数、安全建议须以此为准：`,
    ``,
    profileText,
    ``,
    `**重要：** 本会话仅操作上述硬件，不得假设其他硬件特性。`,
  ].join('\n')
}

