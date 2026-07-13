import { execFile } from 'child_process'
import { promisify } from 'util'
import { isAbsolute, relative, resolve, sep } from 'path'
import type { Charter } from '../charter/CharterTypes.js'
import { readSkill } from '../../tools/system/skill/index.js'
import {
  resolveConfiguredWriteAllowPaths,
  resolveHostPathRequirement,
} from '../../sandbox/configuredWritePaths.js'

const execFileAsync = promisify(execFile)

/** Fail before freezing when reviewed workflow requirements are not deployable. */
export async function preflightCharterCapabilities(
  charter: Charter,
  projectDir: string,
): Promise<void> {
  const worker = charter.seats?.worker
  if (!worker) return

  const missingSkills: string[] = []
  for (const name of worker.skills ?? []) {
    if (!await readSkill(name, projectDir, 'simple_auto')) missingSkills.push(name)
  }
  if (missingSkills.length > 0) {
    throw new Error(
      `worker requires unavailable skill(s): ${missingSkills.join(', ')}. ` +
      'Install them before creating the loop instance.',
    )
  }

  const granted = resolveConfiguredWriteAllowPaths(projectDir)
  const missingHostPaths = (worker.hostRequirements?.writePaths ?? [])
    .map(value => ({ value, resolved: resolveHostPathRequirement(value) }))
    .filter(requirement => !granted.some(root => pathIsUnder(requirement.resolved, root)))
  if (missingHostPaths.length > 0) {
    throw new Error(
      `worker requires host write path(s) not granted by sandbox.writeAllowPaths: ` +
      `${missingHostPaths.map(item => item.value).join(', ')}`,
    )
  }

  const vcs = worker.capabilities?.vcsPublish
  if (vcs) {
    const remote = vcs.remote ?? 'origin'
    try {
      await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
        cwd: projectDir, timeout: 10_000, maxBuffer: 64 * 1024,
      })
      await execFileAsync('git', ['remote', 'get-url', remote], {
        cwd: projectDir, timeout: 10_000, maxBuffer: 64 * 1024,
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`worker vcsPublish requires a git repository with remote '${remote}': ${detail}`)
    }
  }
}

function pathIsUnder(target: string, root: string): boolean {
  const absoluteTarget = resolve(target)
  const absoluteRoot = resolve(root)
  const rel = relative(absoluteRoot, absoluteTarget)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
