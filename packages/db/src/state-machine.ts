import type { ChainActionState, FinancialState, WorkState } from "./types.ts"

const workTransitions: Readonly<Record<WorkState, readonly WorkState[]>> = {
  DRAFT: ["QUOTED", "CANCELED", "EXPIRED"],
  QUOTED: ["AWAITING_PAYMENT", "CANCELED", "EXPIRED"],
  AWAITING_PAYMENT: ["PAYMENT_OBSERVED", "FAILED", "CANCELED", "EXPIRED"],
  PAYMENT_OBSERVED: ["RUNNING", "FAILED"],
  RUNNING: ["OUTPUT_RECEIVED", "FAILED"],
  OUTPUT_RECEIVED: ["OUTPUT_CHECKED", "FAILED"],
  OUTPUT_CHECKED: [],
  FAILED: [],
  EXPIRED: [],
  CANCELED: [],
}

const financialTransitions: Readonly<Record<FinancialState, readonly FinancialState[]>> = {
  UNFUNDED: ["FUNDING_PENDING"],
  FUNDING_PENDING: ["UNFUNDED", "ESCROWED", "UNKNOWN"],
  ESCROWED: ["RESOLUTION_PENDING", "PAID", "REFUNDED", "UNKNOWN"],
  RESOLUTION_PENDING: ["PAID", "REFUNDED", "UNKNOWN"],
  PAID: [],
  REFUNDED: [],
  UNKNOWN: ["UNFUNDED", "FUNDING_PENDING", "ESCROWED", "RESOLUTION_PENDING", "PAID", "REFUNDED"],
}

const actionTransitions: Readonly<Record<ChainActionState, readonly ChainActionState[]>> = {
  PREPARED: ["SUBMITTED", "FAILED", "UNKNOWN"],
  SUBMITTED: ["CONFIRMED", "FAILED", "UNKNOWN"],
  CONFIRMED: [],
  FAILED: [],
  UNKNOWN: ["CONFIRMED", "FAILED"],
}

const assertTransition = <State extends string>(
  current: State,
  next: State,
  transitions: Readonly<Record<State, readonly State[]>>,
  label: string,
): void => {
  if (current !== next && !transitions[current].includes(next)) {
    throw new InvalidStateTransitionError(label, current, next)
  }
}

export class InvalidStateTransitionError extends Error {
  constructor(label: string, current: string, next: string) {
    super(`invalid ${label} transition from ${current} to ${next}`)
    this.name = "InvalidStateTransitionError"
  }
}

export const assertWorkTransition = (current: WorkState, next: WorkState): void =>
  assertTransition(current, next, workTransitions, "work state")

export const assertFinancialTransition = (current: FinancialState, next: FinancialState): void =>
  assertTransition(current, next, financialTransitions, "financial state")

export const assertChainActionTransition = (
  current: ChainActionState,
  next: ChainActionState,
): void => {
  if (current === next) {
    throw new InvalidStateTransitionError("chain action state", current, next)
  }
  assertTransition(current, next, actionTransitions, "chain action state")
}
