"use client"

import { useCallback, useState } from "react"
import "./styles/hire.css"
import {
  CallList,
  NoticeBanner,
  TermList,
  refusal,
  unresolved,
  type CallProgress,
  type HireEnvelope,
  type Notice,
} from "./HireReview"
import {
  awaitSettlement,
  ensureBscTestnet,
  readInjectedProvider,
  requestAccount,
  submitCall,
  type Eip1193Provider,
  type WalletCall,
} from "./wallet"

interface PreparedHire {
  envelope: HireEnvelope
  calls: readonly WalletCall[]
  observedAtUtc: string
  blockNumber: string | null
}

const classifyRefusal = (status: number, detail: string): Notice => {
  if (status === 503) {
    return refusal("Commerce writes are suspended", `${detail} Nothing was signed and no funds moved.`)
  }
  if (status === 409 && /QUOTE_EXPIRED/.test(detail)) {
    return refusal("The signed quote expired", "Request a fresh quote before hiring. No funds moved.")
  }
  if (status === 409) return refusal("Preparation refused", `${detail} No funds moved.`)
  return refusal("The hire could not be prepared", `${detail} No funds moved.`)
}

export function HirePanel({ verifiedQuoteId }: { verifiedQuoteId: string }) {
  const [prepared, setPrepared] = useState<PreparedHire | null>(null)
  const [progress, setProgress] = useState<readonly CallProgress[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)

  const prepare = useCallback(async () => {
    setBusy(true)
    setNotice(null)
    setProgress([])
    try {
      const response = await fetch("/api/hires/prepare", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": verifiedQuoteId },
        body: JSON.stringify({ verifiedQuoteId }),
      })
      const body = await response.json() as Partial<PreparedHire> & { explanation?: string }
      if (response.status === 200 && body.envelope && body.calls) {
        setPrepared(body as PreparedHire)
        return
      }
      setNotice(classifyRefusal(response.status, body.explanation ?? "The service gave no explanation."))
    } catch {
      setNotice(unresolved("The preparation request did not complete. Nothing was signed; confirm before retrying."))
    } finally {
      setBusy(false)
    }
  }, [verifiedQuoteId])

  const switchNetwork = useCallback(async () => {
    const provider = readInjectedProvider()
    if (!provider) return
    const network = await ensureBscTestnet(provider)
    if (network.status === "ready") setNotice(null)
    else if (network.status === "rejected") {
      setNotice(refusal("You declined the network switch", "BSC testnet (97) is required.", true))
    } else setNotice(refusal("Wrong network", network.detail, true))
  }, [])

  const approve = useCallback(async (hire: PreparedHire) => {
    setBusy(true)
    setNotice(null)
    try {
      const provider = readInjectedProvider()
      if (!provider) {
        setNotice(refusal("No wallet detected", "Install a BSC testnet wallet in this browser, then reload."))
        return
      }
      if (Math.floor(Date.now() / 1000) >= hire.envelope.quoteExpiresAtUnix) {
        setNotice(refusal("The signed quote expired", "Request a fresh quote before hiring. No funds moved."))
        return
      }
      const account = await requestAccount(provider)
      if (account.status === "rejected") {
        setNotice(refusal("You declined the connection", "No signature was requested and no funds moved."))
        return
      }
      if (account.status === "unavailable") {
        setNotice(refusal("The wallet is unavailable", account.detail))
        return
      }
      const network = await ensureBscTestnet(provider)
      if (network.status === "rejected") {
        setNotice(refusal("You declined the network switch", "BSC testnet (97) is required.", true))
        return
      }
      if (network.status === "unavailable") {
        setNotice(refusal("Wrong network", network.detail, true))
        return
      }
      await runCalls(provider, account.address, hire, setProgress, setNotice)
    } finally {
      setBusy(false)
    }
  }, [])

  if (!prepared) {
    return (
      <section className="hire">
        <h2 className="hire__title">Review before you approve</h2>
        <NoticeBanner notice={notice} onSwitch={switchNetwork} />
        <button className="hire__approve" type="button" onClick={() => { void prepare() }} disabled={busy}>
          {busy ? "Preparing…" : "Prepare hire for review"}
        </button>
      </section>
    )
  }

  const started = progress.length > 0
  const { callCount } = prepared.envelope

  return (
    <section className="hire">
      <h2 className="hire__title">Review before you approve</h2>
      <p className="hire__lede">
        Approving signs {callCount} wallet {callCount === 1 ? "call" : "calls"} on BSC testnet (97).
        Read every line first — nothing is signed until you approve.
      </p>
      <TermList envelope={prepared.envelope} />
      <NoticeBanner notice={notice} onSwitch={switchNetwork} />
      {started ? <CallList progress={progress} /> : null}
      <button
        className="hire__approve"
        type="button"
        onClick={() => { void approve(prepared) }}
        disabled={busy || started}
      >
        {busy ? "Awaiting your wallet…" : `Approve and sign ${callCount} calls`}
      </button>
    </section>
  )
}

async function runCalls(
  provider: Eip1193Provider,
  from: string,
  hire: PreparedHire,
  setProgress: (value: readonly CallProgress[]) => void,
  setNotice: (value: Notice) => void,
): Promise<void> {
  const ledger: CallProgress[] = hire.calls.map(() => ({ state: "waiting", transactionHash: null }))
  const halt = (index: number, state: CallProgress["state"], message: Notice): void => {
    const entry = ledger[index]
    if (entry) entry.state = state
    for (let rest = index + 1; rest < ledger.length; rest += 1) {
      const pending = ledger[rest]
      if (pending) pending.state = "not attempted"
    }
    setProgress([...ledger])
    setNotice(message)
  }
  setProgress([...ledger])

  for (let index = 0; index < hire.calls.length; index += 1) {
    const call = hire.calls[index]
    const entry = ledger[index]
    if (!call || !entry) return
    const label = `Call ${index + 1}`

    const submitted = await submitCall(provider, from, call)
    if (submitted.status === "rejected") {
      return halt(index, "not attempted", refusal("You rejected the signature", `${label} was not sent. No funds moved.`))
    }
    if (submitted.status === "reverted") {
      return halt(index, "reverted", refusal("A call reverted", `${label} reverted: ${submitted.detail}`))
    }
    if (submitted.status === "unresolved") {
      return halt(index, "unresolved", unresolved(`${label} has no known outcome: ${submitted.detail} Reconcile it before retrying.`))
    }

    entry.state = "submitted"
    entry.transactionHash = submitted.transactionHash
    setProgress([...ledger])

    const settlement = await awaitSettlement(provider, submitted.transactionHash)
    if (settlement.status === "reverted") {
      return halt(index, "reverted", refusal("A call reverted", `${label} was mined but reverted. Transaction ${settlement.transactionHash}.`))
    }
    if (settlement.status === "unresolved") {
      return halt(index, "unresolved", unresolved(`${label} was submitted as ${settlement.transactionHash} but no receipt was read. It is neither confirmed nor failed; reconcile it before retrying.`))
    }
    entry.state = "confirmed"
    setProgress([...ledger])
  }
}
