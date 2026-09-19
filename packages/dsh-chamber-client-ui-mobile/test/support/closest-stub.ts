/**
 * A closest() stub shared by the pure interaction-predicate tests: per-selector
 * match answer (an element matches many ancestor selectors; the real DOM
 * resolves the nearest, the predicate only asks yes/no per selector).
 */
export class ClosestStub {
  readonly match: Record<string, boolean>
  constructor(match: Record<string, boolean>) { this.match = match }
  closest(selector: string): ClosestStub | null {
    return this.match[selector] === true ? this : null
  }
}
