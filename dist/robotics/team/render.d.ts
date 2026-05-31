/**
 * Pure markdown renderers for the v2.0 derived views.
 *
 *   board.md  — who has what (with 🔒 lock markers and ⚠ stale warnings)
 *   log.md    — recent attempts across the whole team
 *   goals.md  — project goals
 *   README.md — file inventory + commit conventions
 *
 * All renderers are pure functions of TeamState (or static text) — no IO.
 */
import { type TeamState } from './types.js';
export declare function renderBoard(state: TeamState): string;
export declare function renderLog(state: TeamState, limit?: number): string;
export declare function renderGoals(state: TeamState): string;
export declare function renderReadme(): string;
//# sourceMappingURL=render.d.ts.map