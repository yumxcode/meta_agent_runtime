/** Restricted JSON shape schema accepted by frozen graph state and outputs. */
export type ShapeSpec =
  | {
      type: 'object'
      required?: string[]
      properties?: Record<string, ShapeSpec>
      additionalProperties?: boolean
    }
  | { type: 'array'; minItems?: number; items?: ShapeSpec }
  | { type: 'string'; minLength?: number; enum?: string[] }
  | { type: 'number'; minimum?: number; maximum?: number }
  | { type: 'integer'; minimum?: number; maximum?: number }
  | { type: 'boolean' }
  | { type: 'null' }

