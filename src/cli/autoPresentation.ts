/**
 * Attached mode already emits one authoritative `[auto-attached] waiting …`
 * line after the durable wake is armed. Hide the earlier parked-result
 * presentation so the same deadline, usage footer, and wake identity are not
 * printed repeatedly.
 */
export function shouldSuppressAttachedParkPresentation(
  attachedLease: boolean,
  resultSubtype: string,
): boolean {
  return attachedLease && resultSubtype === 'parked'
}
