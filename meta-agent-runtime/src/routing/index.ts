/**
 * Routing layer — ModeDetector + SessionRouter.
 */

export type {
  SessionMode,
  SessionModeHint,
  DetectionConfidence,
  ModeSignal,
  ModeDetectionResult,
  RouterOptions,
} from './types.js'

export { MODE_WEIGHT } from './types.js'
export { ModeDetector } from './ModeDetector.js'
export { SessionRouter } from './SessionRouter.js'
