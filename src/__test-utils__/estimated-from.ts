import { resolvePricing } from '../metrics/model-pricing.js';

/**
 * The sibling the resolver currently estimates `model` from. Tests that check
 * the estimate is carried through use this instead of a literal, because the
 * newest priced sibling changes with every vendored pricing-table sync.
 */
export function estimatedFromOf(model: string): string {
  const r = resolvePricing(model);
  if (r.kind !== 'priced' || r.source !== 'estimated') {
    throw new Error(`${model} is not family-estimated`);
  }
  return r.estimatedFrom;
}
