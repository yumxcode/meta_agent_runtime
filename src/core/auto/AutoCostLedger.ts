/**
 * AutoCostLedger — session-wide cost accounting for unattended runs.
 *
 * The main kernel reports its cumulative spend, while SubAgentBridge reserves
 * each child task's declared cap before it starts and settles the actual cost
 * on completion. Reservations are included in the main loop's budget check so
 * concurrent work cannot over-commit the session budget.
 */

export interface AutoCostBreakdown {
  budgetUsd: number
  mainCostUsd: number
  subAgentCostUsd: number
  reservedSubAgentBudgetUsd: number
  totalCostUsd: number
  committedCostUsd: number
  remainingBudgetUsd: number
}

function normalizedUsd(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0
}

function sum(values: Iterable<number>): number {
  let total = 0
  for (const value of values) total += value
  return total
}

export class AutoCostLedger {
  private mainCostUsd = 0
  private readonly settledTaskCosts = new Map<string, number>()
  private readonly reservedTaskBudgets = new Map<string, number>()

  constructor(readonly budgetUsd: number) {
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
      throw new Error('AutoCostLedger requires a finite positive budget.')
    }
  }

  recordMainCost(costUsd: number): void {
    if (!Number.isFinite(costUsd) || costUsd < 0) return
    // Kernel cost is cumulative and monotonic for a session. Keeping the
    // maximum also protects against a stale callback arriving after a retry.
    this.mainCostUsd = Math.max(this.mainCostUsd, costUsd)
  }

  tryReserveTask(taskId: string, budgetUsd: number): boolean {
    if (!Number.isFinite(budgetUsd) || budgetUsd < 0) return false
    if (this.reservedTaskBudgets.has(taskId) || this.settledTaskCosts.has(taskId)) return false
    if (this.committedCostUsd() + budgetUsd > this.budgetUsd) return false
    this.reservedTaskBudgets.set(taskId, budgetUsd)
    return true
  }

  releaseTaskReservation(taskId: string): void {
    this.reservedTaskBudgets.delete(taskId)
  }

  settleTask(taskId: string, actualCostUsd: number | undefined): void {
    if (this.settledTaskCosts.has(taskId)) return
    this.reservedTaskBudgets.delete(taskId)
    this.settledTaskCosts.set(taskId, normalizedUsd(actualCostUsd))
  }

  /** Actual child spend plus outstanding child reservations. Used for limits. */
  getAdditionalBudgetUsd(): number {
    return sum(this.settledTaskCosts.values()) + sum(this.reservedTaskBudgets.values())
  }

  /** Actual spend only. Used for operator-facing cost reporting. */
  getTotalCostUsd(): number {
    return this.mainCostUsd + sum(this.settledTaskCosts.values())
  }

  getBreakdown(): AutoCostBreakdown {
    const subAgentCostUsd = sum(this.settledTaskCosts.values())
    const reservedSubAgentBudgetUsd = sum(this.reservedTaskBudgets.values())
    const totalCostUsd = this.mainCostUsd + subAgentCostUsd
    const committedCostUsd = totalCostUsd + reservedSubAgentBudgetUsd
    return {
      budgetUsd: this.budgetUsd,
      mainCostUsd: this.mainCostUsd,
      subAgentCostUsd,
      reservedSubAgentBudgetUsd,
      totalCostUsd,
      committedCostUsd,
      remainingBudgetUsd: Math.max(0, this.budgetUsd - committedCostUsd),
    }
  }

  private committedCostUsd(): number {
    return this.mainCostUsd + this.getAdditionalBudgetUsd()
  }
}
