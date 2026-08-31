/**
 * Human-readable durations.
 *
 * Lives in `infra/` because the kernel needs it too and must not import from
 * `cli/`. Milliseconds are a machine unit: a message that reads "reached its
 * 7200000ms wall-clock limit" forces the reader to do arithmetic before they can
 * tell whether the ceiling was two hours or two minutes — exactly when they are
 * already trying to work out why their run stopped.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return `${ms}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 ? `${minutes}m${seconds % 60}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours}h${minutes % 60}m` : `${hours}h`
}
