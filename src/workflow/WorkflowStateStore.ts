import { join } from 'path'
import { createHash } from 'node:crypto'
import { atomicWriteJson, readJsonFile } from '../infra/persist/index.js'
import type { WorkflowDefinition, WorkflowPhase, WorkflowState, GateCheckResult } from './types.js'

export class WorkflowStateStore {
  static stateFile(projectDir: string, sessionId?: string): string {
    if (!sessionId) return join(projectDir, '.meta-agent', 'workflow-state.json')
    return join(projectDir, '.meta-agent', 'workflows', safeSessionFileName(sessionId) + '.json')
  }

  static async read(projectDir: string, sessionId?: string): Promise<WorkflowState | null> {
    const current = await readJsonFile<WorkflowState>(WorkflowStateStore.stateFile(projectDir, sessionId))
    if (current?.schemaVersion === '1.0') return current
    if (!sessionId) return null
    // One-release compatibility fallback. A compatible caller migrates this
    // snapshot into its own session file in readCompatible().
    const legacy = await readJsonFile<WorkflowState>(WorkflowStateStore.stateFile(projectDir))
    return legacy?.schemaVersion === '1.0' ? legacy : null
  }

  static isCompatible(definition: WorkflowDefinition, state: WorkflowState): boolean {
    if (state.schemaVersion !== '1.0') return false
    if (state.mode !== definition.mode) return false
    if (state.workflowSourceFile !== definition.sourceFile) return false
    if (definition.workflowBlockHash && state.workflowBlockHash !== definition.workflowBlockHash) return false
    if (definition.workflowDefinitionHash && state.workflowDefinitionHash !== definition.workflowDefinitionHash) return false
    return definition.phases.some(p => p.id === state.currentPhaseId)
  }

  static async readCompatible(
    projectDir: string,
    definition: WorkflowDefinition,
    sessionId?: string,
  ): Promise<WorkflowState | null> {
    const state = await WorkflowStateStore.read(projectDir, sessionId)
    if (!state || !WorkflowStateStore.isCompatible(definition, state)) return null
    if (sessionId) {
      const sessionFile = WorkflowStateStore.stateFile(projectDir, sessionId)
      const alreadyMigrated = await readJsonFile<WorkflowState>(sessionFile)
      if (!alreadyMigrated) await atomicWriteJson(sessionFile, state)
    }
    return state
  }

  static async write(projectDir: string, state: WorkflowState, sessionId?: string): Promise<void> {
    await atomicWriteJson(WorkflowStateStore.stateFile(projectDir, sessionId), state)
  }

  static async initialize(
    projectDir: string,
    definition: WorkflowDefinition,
    sessionId?: string,
  ): Promise<WorkflowState> {
    const firstPhase = definition.phases[0]
    if (!firstPhase) throw new Error('Workflow has no phases')
    const state: WorkflowState = {
      schemaVersion: '1.0',
      projectDir,
      mode: definition.mode,
      workflowSourceFile: definition.sourceFile,
      workflowBlockHash: definition.workflowBlockHash,
      workflowDefinitionHash: definition.workflowDefinitionHash,
      currentPhaseId: firstPhase.id,
      currentPhaseEnteredAt: Date.now(),
      completedGateItems: [],
      phaseHistory: [{ phaseId: firstPhase.id, enteredAt: Date.now(), advancedBy: 'agent' }],
    }
    await WorkflowStateStore.write(projectDir, state, sessionId)
    return state
  }

  static async completeGateItem(projectDir: string, gateItemId: string, sessionId?: string): Promise<WorkflowState> {
    const state = await WorkflowStateStore.read(projectDir, sessionId)
    if (!state) throw new Error('Workflow state not initialised')
    if (!state.completedGateItems.includes(gateItemId)) {
      state.completedGateItems.push(gateItemId)
      await WorkflowStateStore.write(projectDir, state, sessionId)
    }
    return state
  }

  static async completeCurrentPhaseGateItem(
    projectDir: string,
    definition: WorkflowDefinition,
    gateItemId: string,
    sessionId?: string,
  ): Promise<WorkflowState> {
    const state = await WorkflowStateStore.readCompatible(projectDir, definition, sessionId)
    if (!state) throw new Error('Workflow state is not compatible with current definition')
    const phase = definition.phases.find(p => p.id === state.currentPhaseId)
    if (!phase) throw new Error(`Unknown workflow phase: ${state.currentPhaseId}`)
    if (!phase.gateItems.some(g => g.id === gateItemId)) {
      throw new Error(`Gate "${gateItemId}" is not part of the current workflow phase`)
    }
    if (!state.completedGateItems.includes(gateItemId)) {
      state.completedGateItems.push(gateItemId)
      await WorkflowStateStore.write(projectDir, state, sessionId)
    }
    return state
  }

  static async advancePhase(
    projectDir: string,
    definition: WorkflowDefinition,
    advancedBy: 'agent' | 'user',
    sessionId?: string,
  ): Promise<{ newPhase: WorkflowPhase; state: WorkflowState }> {
    const state = await WorkflowStateStore.readCompatible(projectDir, definition, sessionId)
    if (!state) throw new Error('Workflow state is not compatible with current definition')
    const currentIdx = definition.phases.findIndex(p => p.id === state.currentPhaseId)
    if (currentIdx < 0) throw new Error(`Unknown workflow phase: ${state.currentPhaseId}`)
    const nextPhase = definition.phases[currentIdx + 1]
    if (!nextPhase) throw new Error('Already at the final phase')
    const now = Date.now()
    const hist = state.phaseHistory.find(h => h.phaseId === state.currentPhaseId && !h.completedAt)
    if (hist) hist.completedAt = now
    state.currentPhaseId = nextPhase.id
    state.currentPhaseEnteredAt = now
    state.phaseHistory.push({ phaseId: nextPhase.id, enteredAt: now, advancedBy })
    await WorkflowStateStore.write(projectDir, state, sessionId)
    return { newPhase: nextPhase, state }
  }

  static checkGates(definition: WorkflowDefinition, state: WorkflowState): GateCheckResult {
    const phase = definition.phases.find(p => p.id === state.currentPhaseId)
    if (!phase) {
      return {
        canAdvance: false,
        blockedBy: [],
        needsApproval: [],
        suggested: [],
      }
    }
    const completed = new Set(state.completedGateItems)
    const gates = phase.gateItems.map(g => ({ ...g, completed: completed.has(g.id) }))
    return {
      canAdvance: gates.filter(g => g.type === 'REQUIRED').every(g => g.completed),
      blockedBy: gates.filter(g => g.type === 'REQUIRED' && !g.completed),
      needsApproval: gates.filter(g => g.type === 'APPROVAL' && !g.completed),
      suggested: gates.filter(g => g.type === 'SUGGESTED' && !g.completed),
    }
  }
}

function safeSessionFileName(sessionId: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) return sessionId
  return createHash('sha256').update(sessionId).digest('hex')
}
