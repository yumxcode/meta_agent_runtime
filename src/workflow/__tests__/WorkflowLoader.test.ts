import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkflowLoader } from '../WorkflowLoader.js'

const tempDirs: string[] = []
let originalHome: string | undefined

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'meta-agent-workflow-loader-'))
  tempDirs.push(dir)
  return dir
}

async function writeProjectFile(project: string, rel: string, content: string): Promise<void> {
  const path = join(project, rel)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf-8')
}

const validWorkflow = `# Robotics Workflow
Mode: robotics
Version: 1.0

## Phase: inspect | 检查 | Inspect
- [ ] REQUIRED: Inspect current state

### Outputs
- Inspection notes
`

beforeEach(async () => {
  originalHome = process.env.HOME
  const home = await tempProject()
  process.env.HOME = home
})

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('WorkflowLoader explicit opt-in', () => {
  it('does not create workflow state from untagged AGENT.md', async () => {
    const project = await tempProject()
    await writeProjectFile(project, 'AGENT.md', '# Agent\n\nUse careful robotics defaults.\n')

    expect(WorkflowLoader.load('robotics', project)).toBeNull()
    expect(WorkflowLoader.loadAgentDirectives(project)).toContain('Use careful robotics defaults.')
  })

  it('loads workflow from META-WORKFLOW block and strips that block from D1c directives', async () => {
    const project = await tempProject()
    await writeProjectFile(project, 'AGENT.md', `# Agent

Soft rule stays visible.

<META-WORKFLOW mode="robotics">
${validWorkflow}
</META-WORKFLOW>

Another soft rule.
`)

    const def = WorkflowLoader.load('robotics', project)
    expect(def?.sourceKind).toBe('agent_tag')
    expect(def?.phases.map(p => p.id)).toEqual(['inspect'])
    expect(def?.workflowBlockHash).toMatch(/^[a-f0-9]{64}$/)
    expect(def?.workflowDefinitionHash).toMatch(/^[a-f0-9]{64}$/)

    const directives = WorkflowLoader.loadAgentDirectives(project)
    expect(directives).toContain('Soft rule stays visible.')
    expect(directives).toContain('Another soft rule.')
    expect(directives).not.toContain('META-WORKFLOW')
    expect(directives).not.toContain('## Phase:')
  })

  it('prefers an explicit workflow file over an AGENT.md workflow block', async () => {
    const project = await tempProject()
    await writeProjectFile(project, 'AGENT.md', `<META-WORKFLOW mode="robotics">
${validWorkflow}
</META-WORKFLOW>`)
    await writeProjectFile(project, '.meta-agent/workflows/robotics.md', `# File Workflow
Mode: robotics
Version: 1.0

## Phase: file_phase | 文件 | File
- [ ] REQUIRED: Use workflow file
`)

    const def = WorkflowLoader.load('robotics', project)
    expect(def?.sourceKind).toBe('workflow_file')
    expect(def?.phases.map(p => p.id)).toEqual(['file_phase'])
  })

  it('repairs an invalid tagged workflow only when a repairer is provided', async () => {
    const project = await tempProject()
    await writeProjectFile(project, 'AGENT.md', `<META-WORKFLOW mode="robotics">
Start by inspecting the robot, then require approval before hardware execution.
</META-WORKFLOW>`)

    await expect(WorkflowLoader.loadWithRepair('robotics', project)).resolves.toBeNull()

    const def = await WorkflowLoader.loadWithRepair('robotics', project, async () => validWorkflow)
    expect(def?.sourceKind).toBe('agent_tag')
    expect(def?.phases.map(p => p.id)).toEqual(['inspect'])
  })
})
