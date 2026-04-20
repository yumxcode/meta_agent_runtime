/**
 * SharedBudget — 跨 parent/child Agent 共享的 iteration 额度池
 *
 * 核心设计：
 *  - 单一引用共享：parent 和所有 child 持有同一个 SharedBudget 实例
 *  - tryConsume() 原子化地检查并消费（JS 单线程，Promise.all 并发下无真正竞态）
 *  - exhausted 后任何 Agent 的新一轮 LLM 调用都会被拒绝
 */

export class SharedBudget {
  private _remaining: number;
  readonly max: number;

  constructor(max: number) {
    if (max <= 0) throw new RangeError(`SharedBudget max must be > 0, got ${max}`);
    this._remaining = max;
    this.max = max;
  }

  get remaining(): number {
    return this._remaining;
  }

  get used(): number {
    return this.max - this._remaining;
  }

  get exhausted(): boolean {
    return this._remaining <= 0;
  }

  /**
   * 原子消费 n 个 iteration。
   * 返回 true 表示消费成功，false 表示余额不足（不会修改余额）。
   */
  tryConsume(n = 1): boolean {
    if (this._remaining < n) return false;
    this._remaining -= n;
    return true;
  }

  /**
   * 强制消费（不检查余额），用于确保计数准确的场景。
   */
  consume(n = 1): void {
    this._remaining = Math.max(0, this._remaining - n);
  }

  /**
   * 返回当前状态快照（用于日志 / DelegateResult 上报）。
   */
  snapshot(): { remaining: number; used: number; max: number } {
    return { remaining: this._remaining, used: this.used, max: this.max };
  }

  /**
   * 创建一个不共享父预算的独立子预算（仅用于测试或特殊隔离场景）。
   */
  static isolated(max: number): SharedBudget {
    return new SharedBudget(max);
  }
}
