export type SessionHireAuthorityCode =
  | "COMMERCE_NOT_VERIFIED"
  | "POLICY_NOT_SELECTED"
  | "CALL_COUNT_MISMATCH"
  | "NO_CALLS_TO_SCOPE"
  | "CALL_CARRIES_NATIVE_VALUE"
  | "SELECTOR_MISSING"
  | "WILDCARD_SELECTOR"
  | "EMPTY_CALLDATA_SELECTOR"
  | "WILDCARD_TARGET"
  | "TARGET_OUTSIDE_MANIFEST"
  | "ENVELOPE_CONTRACT_OFF_MANIFEST"
  | "TOKEN_CALL_COUNT_UNEXPECTED"
  | "TOKEN_CALL_NOT_APPROVAL"
  | "APPROVAL_SPENDER_NOT_COMMERCE"
  | "APPROVAL_AMOUNT_NOT_BUDGET"
  | "FUND_CALL_COUNT_UNEXPECTED"
  | "FUND_AMOUNT_NOT_BUDGET"
  | "FUND_JOB_ID_MISMATCH"
  | "BUDGET_NOT_POSITIVE"
  | "TOKEN_CAP_EXCEEDS_BUDGET"
  | "TOKEN_CAP_BELOW_BUDGET"
  | "EXPIRY_NOT_FUTURE"
  | "EXPIRY_OUTLIVES_JOB"
  | "JOB_ALREADY_EXPIRED"
  | "SPEND_WINDOW_UNBOUNDED"
  | "RELAY_ALLOWANCE_NOT_POSITIVE"
  | "RELAY_ALLOWANCE_ABOVE_CEILING"

export class SessionHireAuthorityError extends Error {
  readonly code: SessionHireAuthorityCode
  constructor(code: SessionHireAuthorityCode, message: string) {
    super(message)
    this.name = "SessionHireAuthorityError"
    this.code = code
  }
}

export function refuse(code: SessionHireAuthorityCode, message: string): never {
  throw new SessionHireAuthorityError(code, message)
}
