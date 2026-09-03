export interface StaleToolBatchRecovery {
  completedBatches: number
  staleToolUseIds: string[]
}

/** Counts completed model tool batches without treating parallel tools as turns. */
export class CompletedToolBatchCounter {
  private readonly pendingToolUseIds = new Set<string>()
  private completed = 0
  private sawResultInCurrentBatch = false

  /**
   * Kernel emits every tool_use in a batch before any of its tool_result events.
   * Therefore a new tool_use after partial results proves the preceding batch
   * lost at least one result. Recover at that exact boundary instead of using an
   * arbitrary N-result threshold that could break a legitimate large batch.
   */
  observeToolUse(toolUseId: string): StaleToolBatchRecovery | undefined {
    let recovery: StaleToolBatchRecovery | undefined
    if (this.pendingToolUseIds.size > 0 && this.sawResultInCurrentBatch) {
      const staleToolUseIds = [...this.pendingToolUseIds]
      this.pendingToolUseIds.clear()
      this.sawResultInCurrentBatch = false
      this.completed++
      recovery = { completedBatches: this.completed, staleToolUseIds }
    }
    this.pendingToolUseIds.add(toolUseId)
    return recovery
  }

  /** Returns the new completed-batch count exactly once per fully settled batch. */
  observeToolResult(toolUseId: string): number | undefined {
    if (!this.pendingToolUseIds.delete(toolUseId)) {
      if (this.pendingToolUseIds.size > 0) this.sawResultInCurrentBatch = true
      return undefined
    }
    this.sawResultInCurrentBatch = true
    if (this.pendingToolUseIds.size > 0) return undefined
    this.sawResultInCurrentBatch = false
    this.completed++
    return this.completed
  }

  get completedBatches(): number {
    return this.completed
  }
}
