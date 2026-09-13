"use client"

import { useEffect, useState } from "react"
import "./styles/hire.css"
import { CallList, NoticeBanner, TermList, unresolved, type Notice } from "./HireReview"
import { validatePrepared } from "./hire-calls"
import { beginJournal, readJournal } from "./hire-journal"
import { readTestnetReceipt } from "./hire-receipt"
import { recoverHireHash, runHirePhase } from "./hire-runner"
import type { HireJournal } from "./hire-types"
import { ensureBscTestnet, readInjectedProvider, requestAccount } from "./wallet"

export function HirePanel({ verifiedQuoteId }: { verifiedQuoteId: string }) {
  const [journal, setJournal] = useState<HireJournal | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [recoveryHash, setRecoveryHash] = useState("")

  useEffect(() => {
    const refresh = () => {
      try { setJournal(readJournal(localStorage, verifiedQuoteId)); setLoaded(true) }
      catch { setLoaded(false); setNotice(unresolved("Saved progress cannot be read. Restore browser storage before continuing.")) }
    }
    refresh()
    window.addEventListener("storage", refresh)
    return () => window.removeEventListener("storage", refresh)
  }, [verifiedQuoteId])

  const act = async (send: boolean, recoveredHash?: string) => {
    setBusy(true)
    setNotice(null)
    try {
      if (!navigator.locks) throw new Error("This browser cannot safely lock hire attempts across tabs.")
      await navigator.locks.request("knot-hire-wallet", { ifAvailable: true }, async lock => {
        if (!lock) throw new Error("Another tab is handling this hire. Wait and check saved progress.")
        let saved = readJournal(localStorage, verifiedQuoteId)
        if (!saved) {
          const response = await fetch("/api/hires/prepare", {
            method: "POST", headers: { "content-type": "application/json", "idempotency-key": verifiedQuoteId },
            body: JSON.stringify({ verifiedQuoteId }), signal: AbortSignal.timeout(50_000),
          })
          const body = await response.json()
          if (!response.ok) throw new Error(body.explanation ?? "Hire preparation was refused.")
          const prepared = validatePrepared(body, verifiedQuoteId)
          saved = beginJournal(localStorage, prepared)
          setJournal(saved)
          return
        }
        const provider = readInjectedProvider()
        if (!provider) throw new Error("Connect a browser wallet to recover or continue this hire.")
        if (send) {
          const account = await requestAccount(provider)
          if (account.status !== "connected") throw new Error("Wallet connection was not approved.")
          if (account.address.toLowerCase() !== saved.prepared.envelope.buyer.toLowerCase()) throw new Error("Connect the buyer account shown below. No transaction was requested.")
          const network = await ensureBscTestnet(provider)
          if (network.status !== "ready") throw new Error("BSC testnet (97) is required. No transaction was requested.")
        }
        const runner = { storage: localStorage, provider, receipt: readTestnetReceipt, now: () => Math.floor(Date.now() / 1000), changed: setJournal }
        if (recoveredHash) await recoverHireHash(verifiedQuoteId, recoveredHash, runner)
        else await runHirePhase(verifiedQuoteId, runner, send)
        setJournal(readJournal(localStorage, verifiedQuoteId))
      })
    } catch (error) {
      setNotice(unresolved(error instanceof Error ? error.message : "The attempt could not be reconciled. Check saved progress before continuing."))
    } finally { setBusy(false) }
  }

  const completed = journal?.prepared.stage === "FUND" && journal.progress.every(p => p.state === "confirmed")
  const pending = journal?.progress.some(p => ["signing", "submitted", "unresolved"].includes(p.state)) ?? false
  const reverted = journal?.progress.some(p => p.state === "reverted") ?? false
  return (
    <section className="hire">
      <h2 className="hire__title">Review before you approve</h2>
      <p className="hire__lede">First create the job on BSC testnet (97). After its actual identifier is verified, review and approve each funding call. Progress is saved in this browser; do not clear site data or switch devices during an attempt.</p>
      {journal ? <>
        <TermList envelope={journal.prepared.envelope} />
        <CallList progress={journal.progress} />
        {journal.creationHash ? <p>Creation transaction: {journal.creationHash}</p> : null}
      </> : null}
      <NoticeBanner notice={notice} onSwitch={() => { void act(false) }} />
      {completed ? <p role="status">All funding calls confirmed. This does not mean the seller has delivered or the payment has settled.</p> : null}
      <button className="hire__approve" type="button" disabled={busy || !loaded || !!completed || reverted} onClick={() => { void act(!pending) }}>
        {busy ? "Checking saved progress…" : !journal ? "Prepare hire for review" : pending ? "Check saved transaction" : journal.prepared.stage === "CREATE" ? "Approve job creation" : "Approve next funding call"}
      </button>
      {journal && !completed ? <button type="button" disabled={busy} onClick={() => { void act(false) }}>Recover saved progress without signing</button> : null}
      {journal?.progress.some(p => p.transactionHash === null && ["signing", "unresolved"].includes(p.state)) ? <div>
        <label>Recover a transaction hash from your wallet <input value={recoveryHash} onChange={event => setRecoveryHash(event.target.value)} placeholder="0x…" /></label>
        <button type="button" disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash)} onClick={() => { void act(false, recoveryHash) }}>Verify and recover this hash</button>
      </div> : null}
    </section>
  )
}
