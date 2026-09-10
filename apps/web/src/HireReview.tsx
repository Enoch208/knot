"use client"

import { formatUnits } from "viem"

const PAYMENT_TOKEN_DECIMALS = 18

export interface HireEnvelope {
  chainId: number
  jobId: string
  buyer: string
  provider: string
  budgetBaseUnits: string
  paymentToken: string
  commerce: string
  policy: string
  disputeWindowSeconds: number
  expiredAtUnix: number
  quoteExpiresAtUnix: number
  callCount: number
}

export type CallState =
  | "waiting"
  | "submitted"
  | "confirmed"
  | "reverted"
  | "unresolved"
  | "not attempted"

export interface CallProgress {
  state: CallState
  transactionHash: string | null
}

export interface Notice {
  tone: "refusal" | "unresolved"
  title: string
  detail: string
  offerSwitch: boolean
}

export const refusal = (title: string, detail: string, offerSwitch = false): Notice => ({
  tone: "refusal",
  title,
  detail,
  offerSwitch,
})

export const unresolved = (detail: string): Notice => ({
  tone: "unresolved",
  title: "Unresolved — this must be reconciled",
  detail,
  offerSwitch: false,
})

const utc = (unix: number): string => new Date(unix * 1000).toISOString().replace(".000Z", "Z")

export function TermList({ envelope }: { envelope: HireEnvelope }) {
  const budget = formatUnits(BigInt(envelope.budgetBaseUnits), PAYMENT_TOKEN_DECIMALS)
  const terms: readonly { label: string; value: string; emphasis?: boolean }[] = [
    { label: "Provider", value: envelope.provider },
    { label: "Budget", value: `${budget} U`, emphasis: true },
    { label: "Budget in base units", value: envelope.budgetBaseUnits },
    { label: "Payment token", value: envelope.paymentToken },
    { label: "Commerce contract", value: envelope.commerce },
    { label: "Policy", value: envelope.policy },
    { label: "Dispute window", value: `${envelope.disputeWindowSeconds} seconds` },
    { label: "Job expires", value: `${utc(envelope.expiredAtUnix)} (unix ${envelope.expiredAtUnix})` },
    { label: "Quote expires", value: `${utc(envelope.quoteExpiresAtUnix)} (unix ${envelope.quoteExpiresAtUnix})` },
    { label: "Wallet calls", value: String(envelope.callCount) },
    { label: "Job identifier", value: envelope.jobId },
    { label: "Buyer", value: envelope.buyer },
  ]
  return (
    <dl className="hire__terms">
      {terms.map((term) => (
        <div className="hire__term" key={term.label}>
          <dt className="hire__label">{term.label}</dt>
          <dd className={`hire__value hire__value--mono${term.emphasis ? " hire__value--emphasis" : ""}`}>
            {term.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function CallList({ progress }: { progress: readonly CallProgress[] }) {
  return (
    <ol className="hire__calls">
      {progress.map((entry, index) => (
        <li className="hire__call" key={index}>
          <span className="hire__call-index">Call {index + 1}</span>
          <span className={`hire__call-state hire__call-state--${entry.state.replace(/ /g, "-")}`}>
            {entry.state}
          </span>
          <span className="hire__call-hash">{entry.transactionHash ?? "no transaction"}</span>
        </li>
      ))}
    </ol>
  )
}

export function NoticeBanner({ notice, onSwitch }: { notice: Notice | null; onSwitch: () => void }) {
  if (!notice) return null
  return (
    <div className={`hire__notice hire__notice--${notice.tone}`} role="alert">
      <p className="hire__notice-title">{notice.title}</p>
      <p className="hire__notice-detail">{notice.detail}</p>
      {notice.offerSwitch ? (
        <button className="hire__switch" type="button" onClick={onSwitch}>
          Switch to BSC testnet (97)
        </button>
      ) : null}
    </div>
  )
}
