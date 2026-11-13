/**
 * Applies the "highSecurity forcibly disables content recording" rule.
 * `explicitValue` is the recordContent value already resolved from an
 * override or env var by the caller — this function only applies the gate,
 * so the rule can't drift between call sites that each resolve their own
 * `explicitValue` from a differently-named env var.
 */
export function resolveRecordContent(highSecurity: boolean, explicitValue: boolean): boolean {
  return highSecurity ? false : explicitValue;
}
