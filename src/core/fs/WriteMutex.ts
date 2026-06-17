/**
 * PathWriteMutex — a process-global, path-keyed async write lock.
 *
 * Why this exists: in auto mode the main agent and any number of concurrently
 * running sub-agents share one Node process and one workspace. Each runs its own
 * KernelLoop, so two writers can target the same file at the same time and
 * corrupt it. A single shared, normalized-path-keyed mutex serialises writers to
 * the SAME path while letting writers to DIFFERENT paths run fully in parallel.
 *
 * Coupling: this module knows nothing about modes. It is injected into
 * ToolCallContext only when a session is autonomous (MetaAgentSession), and the
 * fs tools acquire it via `ctx.writeMutex` only when present — so non-auto
 * sessions pay nothing and behaviour is unchanged.
 */
import { resolve } from 'path'

export class PathWriteMutex {
  /** path → tail of the in-flight lock chain for that path. */
  private readonly chains = new Map<string, Promise<void>>()

  /**
   * Acquire the lock for `path`. Resolves with a release function once the lock
   * is held. Callers MUST call release() (use try/finally). Concurrent acquires
   * for the same normalized path are served FIFO; different paths never block
   * each other.
   */
  async acquire(path: string): Promise<() => void> {
    const key = resolve(path)
    const previous = this.chains.get(key) ?? Promise.resolve()

    let resolveHeld!: () => void
    const held = new Promise<void>((r) => { resolveHeld = r })

    // The next acquirer for this path waits for THIS holder to release. We keep
    // a reference to the exact tail we install so the release can clean up only
    // when no later acquirer has appended.
    const tail = previous.then(() => held)
    this.chains.set(key, tail)

    // We hold the lock once all prior holders for this path have released.
    await previous

    return () => {
      resolveHeld()
      // Drop the chain entry only if we are still its tail (no one queued after
      // us), so the Map does not grow unbounded across many one-off writes.
      if (this.chains.get(key) === tail) this.chains.delete(key)
    }
  }

  /** Number of paths with an active or queued lock (for tests/observability). */
  get activePathCount(): number {
    return this.chains.size
  }
}

// ── Process-global singleton ──────────────────────────────────────────────────
// One instance per process so the lock is shared across the main session and all
// sub-agent sessions running in the same process.
let _global: PathWriteMutex | undefined

export function getGlobalWriteMutex(): PathWriteMutex {
  if (!_global) _global = new PathWriteMutex()
  return _global
}
