/**
 * `meta-agent evalset` — eval set inspection and case extraction (G1-9).
 *
 * `extract` is deliberately READ-ONLY. It reports what could be recovered from
 * the trajectory corpus and exactly what each candidate is still missing, but
 * writes nothing. Persisting half-finished cases would invite someone —
 * plausibly an agent — to fill the gaps mechanically, and a corpus of cases
 * with placeholder evaluator refs would validate, re-execute, and measure
 * nothing at all. Curation is the human step this gate exists to protect.
 *
 * `list` / `show` / `freeze` operate on real, validated cases in the store.
 */

import { parseArgs } from 'node:util'
import type { CliOptions } from '../args.js'
import { EvalSetStore } from '../../evaluation/EvalSetStore.js'
import { detectSplitLeakage, countReExecutableCases } from '../../evaluation/types.js'
import {
  extractCaseCandidates,
  formatExtractionReport,
} from '../../evaluation/CaseExtractor.js'

interface ParsedEvalsetArgs {
  command: string
  positionals: string[]
  json: boolean
  limit: number
}

export async function runEvalsetCommand(opts: CliOptions): Promise<void> {
  const parsed = parseEvalsetArgs(opts.loopCommand?.args ?? [], opts.json)
  const store = new EvalSetStore()

  switch (parsed.command) {
    case 'extract': {
      const report = await extractCaseCandidates()
      if (parsed.json) console.log(JSON.stringify(report, null, 2))
      else console.log(formatExtractionReport(report, parsed.limit))
      return
    }

    case 'list': {
      const setIds = await store.listSetIds()
      if (parsed.json) {
        const sets = await Promise.all(setIds.map(id => store.loadSet(id)))
        console.log(JSON.stringify(sets.filter(Boolean), null, 2))
        return
      }
      if (setIds.length === 0) {
        console.log('No eval sets yet. `meta-agent evalset extract` shows what could be curated.')
        return
      }
      for (const id of setIds) {
        const set = await store.loadSet(id)
        if (!set) continue
        console.log(
          `${id}  cases=${set.caseIds.length}  ` +
          `${set.frozenAt ? `frozen ${new Date(set.frozenAt).toISOString()}` : 'open'}  ${set.name}`,
        )
      }
      return
    }

    case 'show': {
      const id = parsed.positionals[0]
      if (!id) throw new Error('evalset show requires a set id')
      const set = await store.loadSet(id)
      if (!set) throw new Error(`eval set not found: ${id}`)
      const cases = await store.loadSetCases(id)
      const leaks = detectSplitLeakage(cases)

      if (parsed.json) {
        console.log(JSON.stringify({ set, cases, leaks }, null, 2))
        return
      }

      console.log(`${set.id}  ${set.name}`)
      console.log(`  created  ${new Date(set.createdAt).toISOString()}`)
      console.log(`  frozen   ${set.frozenAt ? new Date(set.frozenAt).toISOString() : 'no'}`)
      console.log(`  cases    ${cases.length}`)
      console.log(`  re-executable ${countReExecutableCases(cases)}`)

      const bySplit = new Map<string, number>()
      for (const evalCase of cases) {
        bySplit.set(evalCase.split, (bySplit.get(evalCase.split) ?? 0) + 1)
      }
      for (const [split, count] of [...bySplit].sort()) {
        console.log(`    ${split.padEnd(14)}${count}`)
      }

      // Printed loudly: a set with leakage produces numbers that measure
      // memorisation while looking entirely normal.
      if (leaks.length > 0) {
        console.log('')
        console.log(`LEAKAGE — ${leaks.length} contamination group(s) span more than one split:`)
        for (const leak of leaks) {
          console.log(`  ${leak.contaminationGroupId}: ${leak.splits.join(' + ')}`)
        }
      }
      return
    }

    case 'freeze': {
      const id = parsed.positionals[0]
      if (!id) throw new Error('evalset freeze requires a set id')
      const cases = await store.loadSetCases(id)
      const leaks = detectSplitLeakage(cases)
      // Refuse rather than warn: freezing is what makes a set citable as the
      // population a result describes, and a leaking population is not one.
      if (leaks.length > 0) {
        throw new Error(
          `refusing to freeze ${id}: ${leaks.length} contamination group(s) span multiple splits ` +
          `(${leaks.map(l => l.contaminationGroupId).join(', ')})`,
        )
      }
      const frozen = await store.freezeSet(id)
      if (parsed.json) console.log(JSON.stringify(frozen, null, 2))
      else console.log(`${id} frozen at ${new Date(frozen.frozenAt!).toISOString()} with ${frozen.caseIds.length} case(s)`)
      return
    }

    default:
      throw new Error(
        `unknown evalset command '${parsed.command}'. ` +
        'Available: extract | list | show <id> | freeze <id>',
      )
  }
}

function parseEvalsetArgs(args: string[], inheritedJson: boolean): ParsedEvalsetArgs {
  const parsed = parseArgs({
    args,
    options: {
      json: { type: 'boolean', short: 'j', default: false },
      limit: { type: 'string', default: '10' },
    },
    strict: true,
    allowPositionals: true,
  })
  const [command = 'list', ...positionals] = parsed.positionals
  const limit = Number(parsed.values.limit ?? '10')
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer')
  return {
    command,
    positionals,
    json: inheritedJson || parsed.values.json === true,
    limit,
  }
}
