/**
 * cli/limits — turn-count defaults shared by the router and the entry point.
 *
 * Their own module because both cli/args.ts and cli/router.ts need them, and
 * putting them in either one would create an import cycle.
 */

/** Default max turns for an interactive/one-shot session. */
export const DEFAULT_CLI_MAX_TURNS = 100

/**
 * Autonomous modes get a far higher ceiling: an unattended run is bounded by
 * wall-clock, budget and the stall circuit, not by turn count, so a low cap
 * only truncates otherwise-healthy work.
 */
export const AUTO_CLI_MAX_TURNS = 1000
