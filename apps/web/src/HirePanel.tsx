"use client"

import { useEffect, useState } from "react"
import "./styles/hire.css"
import { CallList, NoticeBanner, TermList, unresolved, type Notice } from "./HireReview"
import { validatePrepared } from "./hire-calls"
import { beginJournal, readJournal, saveJournal } from "./hire-journal"
import { requestHireLifecycle } from "./hire-lifecycle-client"
import { fundingProof, lifecycleView, parsePublicHireStatus } from "./hire-lifecycle"
import { readTestnetReceipt } from "./hire-receipt"
import { recoverHireHash, runHirePhase } from "./hire-runner"
import type { HireJournal } from "./hire-types"
import { signBuyerIntent } from "./buyer-intent-client"
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
          const provider = readInjectedProvider()
          if (!provider) throw new Error("Connect an EOA browser wallet to bind this hire.")
          const account = await requestAccount(provider)
          if (account.status === "rejected") throw new Error("Wallet connection was declined. No transaction was requested.")
          if (account.status !== "connected") throw new Error(account.detail)
          const network = await ensureBscTestnet(provider)
          if (network.status === "rejected") throw new Error("BSC testnet selection was declined. No transaction was requested.")
          if (network.status !== "ready") throw new Error(network.detail)
          const draftResponse = await fetch("/api/hires/prepare", {
            method: "POST", headers: { "content-type": "application/json", "idempotency-key": verifiedQuoteId },
            body: JSON.stringify({ stage: "DRAFT", verifiedQuoteId, buyer: account.address }), signal: AbortSignal.timeout(10_000),
          })
          const draft = await draftResponse.json() as { explanation?: unknown; buyerIntent?: unknown; message?: unknown }
          if (!draftResponse.ok || typeof draft.buyerIntent !== "string" || typeof draft.message !== "string") {
            throw new Error(typeof draft.explanation === "string" ? draft.explanation : "Buyer binding could not be prepared.")
          }
          const signed = await signBuyerIntent(provider, account.address, draft.message)
          if (signed.status === "rejected") throw new Error("Buyer binding was declined. No transaction was requested.")
          if (signed.status !== "signed") throw new Error(signed.detail)
          const response = await fetch("/api/hires/prepare", {
            method: "POST", headers: { "content-type": "application/json", "idempotency-key": verifiedQuoteId },
            body: JSON.stringify({ verifiedQuoteId, buyerIntent: draft.buyerIntent, buyerSignature: signed.signature }), signal: AbortSignal.timeout(50_000),
          })
          const body = await response.json()
          if (!response.ok) throw new Error(body.explanation ?? "Hire preparation was refused.")
          const prepared = validatePrepared(body, verifiedQuoteId)
          if (prepared.envelope.buyer.toLowerCase() !== account.address.toLowerCase()) {
            throw new Error("The prepared hire does not belong to the connected account.")
          }
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

  const syncLifecycle = async (operation: "funding-confirmation" | "hire-status") => {
    setBusy(true)
    setNotice(null)
    try {
      if (!navigator.locks) throw new Error("This browser cannot safely lock lifecycle checks across tabs.")
      await navigator.locks.request("knot-hire-wallet", { ifAvailable: true }, async lock => {
        if (!lock) throw new Error("Another tab is handling this hire. Wait and check saved progress.")
        const saved = readJournal(localStorage, verifiedQuoteId)
        if (!saved) throw new Error("No saved hire exists on this device.")
        const proofBody = operation === "funding-confirmation" ? fundingProof(saved) : {}
        const provider = readInjectedProvider()
        if (!provider) throw new Error("Connect the buyer EOA to authorize this read-only lifecycle check.")
        const account = await requestAccount(provider)
        if (account.status === "rejected") throw new Error("Wallet connection was declined. No transaction was requested.")
        if (account.status !== "connected") throw new Error(account.detail)
        if (account.address.toLowerCase() !== saved.prepared.envelope.buyer.toLowerCase()) {
          throw new Error("Connect the buyer account shown above. No transaction was requested.")
        }
        const network = await ensureBscTestnet(provider)
        if (network.status === "rejected") throw new Error("BSC testnet selection was declined. No transaction was requested.")
        if (network.status !== "ready") throw new Error(network.detail)

        const priorState = saved.postFunding?.confirmationState ?? "idle"
        const existingProof = operation === "funding-confirmation" ? saved.postFunding?.fundingProof : saved.postFunding?.statusProof
        const persist = () => { saveJournal(localStorage, saved); setJournal(structuredClone(saved)) }
        saved.postFunding = {
          confirmationState: existingProof ? priorState : "signing",
          lastStatus: saved.postFunding?.lastStatus ?? null,
          checkedAtUtc: saved.postFunding?.checkedAtUtc ?? null,
          ...(saved.postFunding?.fundingProof ? { fundingProof: saved.postFunding.fundingProof } : {}),
          ...(saved.postFunding?.statusProof ? { statusProof: saved.postFunding.statusProof } : {}),
        }
        persist()
        const outcome = await requestHireLifecycle(
          provider,
          verifiedQuoteId,
          account.address,
          operation,
          proofBody,
          existingProof,
          signedProof => {
            if (operation === "funding-confirmation") saved.postFunding!.fundingProof = signedProof
            else saved.postFunding!.statusProof = signedProof
            saved.postFunding!.confirmationState = "submitted"
            persist()
          },
        )
        if (outcome.status === "rejected") {
          saved.postFunding.confirmationState = saved.postFunding.lastStatus ? "confirmed" : priorState === "signing" ? "idle" : priorState
          persist()
          throw new Error("Lifecycle authorization was declined. No transaction was requested.")
        }
        if (outcome.status === "unresolved") {
          saved.postFunding.confirmationState = "unresolved"
          persist()
          throw new Error(`${outcome.detail} The saved authorization can be checked again without resending a transaction.`)
        }
        if (![200, 202].includes(outcome.httpStatus)) {
          const response = outcome.body && typeof outcome.body === "object" ? outcome.body as Record<string, unknown> : {}
          saved.postFunding.confirmationState = outcome.httpStatus === 409 ? "conflict" : "unresolved"
          if ([400, 401].includes(outcome.httpStatus)) {
            if (operation === "funding-confirmation") delete saved.postFunding.fundingProof
            else delete saved.postFunding.statusProof
          }
          persist()
          throw new Error(typeof response.explanation === "string" ? response.explanation : "The lifecycle service refused this request.")
        }
        const status = parsePublicHireStatus(outcome.body, saved)
        saved.postFunding.lastStatus = status
        saved.postFunding.checkedAtUtc = new Date().toISOString()
        saved.postFunding.confirmationState = status.verification.state === "CONFIRMED" ? "confirmed" : "pending"
        persist()
      })
    } catch (error) {
      setNotice(unresolved(error instanceof Error ? error.message : "The live lifecycle could not be reconciled."))
    } finally { setBusy(false) }
  }

  const completed = journal?.prepared.stage === "FUND" && journal.progress.every(p => p.state === "confirmed")
  const pending = journal?.progress.some(p => ["signing", "submitted", "unresolved"].includes(p.state)) ?? false
  const reverted = journal?.progress.some(p => p.state === "reverted") ?? false
  const lifecycle = completed ? lifecycleView(journal?.postFunding) : null
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
      {completed && lifecycle ? <section className={`hire-lifecycle hire-lifecycle--${lifecycle.tone}`} aria-labelledby="live-hire-title">
        <div className="hire-lifecycle__heading">
          <div>
            <p className="hire-lifecycle__eyebrow">Live BSC testnet lifecycle</p>
            <h3 id="live-hire-title">{lifecycle.title}</h3>
          </div>
          {journal?.postFunding?.checkedAtUtc ? <p className="hire-lifecycle__checked">Checked {new Date(journal.postFunding.checkedAtUtc).toLocaleString()}</p> : null}
        </div>
        <p className="hire-lifecycle__detail">{lifecycle.detail}</p>
        <ol className="hire-lifecycle__steps">
          {lifecycle.steps.map(step => <li className={`hire-lifecycle__step hire-lifecycle__step--${step.state}`} key={step.label}>
            <span className="hire-lifecycle__dot" aria-hidden="true" />
            <span><strong>{step.label}</strong><small>{step.detail}</small></span>
          </li>)}
        </ol>
        {journal?.postFunding?.lastStatus ? <div className="hire-lifecycle__facts">
          <p><span>Chain job</span><strong>{journal.postFunding.lastStatus.jobId ? `#${journal.postFunding.lastStatus.jobId}` : "Pending verification"}</strong></p>
          <p><span>Seller notice</span><strong>{journal.postFunding.lastStatus.sellerNotification.state.replaceAll("_", " ")}</strong></p>
          <p><span>Work</span><strong>{journal.postFunding.lastStatus.lifecycle.workState.replaceAll("_", " ")}</strong></p>
          <p><span>Funds</span><strong>{journal.postFunding.lastStatus.lifecycle.financialState.replaceAll("_", " ")}</strong></p>
        </div> : null}
        {lifecycle.refundCall ? <div className="hire-lifecycle__refund">
          <strong>Buyer-wallet refund available</strong>
          <p>KNOT has not sent this transaction. The live service returned a canonical BSC testnet call for the connected buyer to review in their wallet.</p>
        </div> : null}
        <div className="hire-lifecycle__actions">
          {!journal?.postFunding?.lastStatus || lifecycle.canRetryConfirmation ? <button className="hire__approve" type="button" disabled={busy} onClick={() => { void syncLifecycle("funding-confirmation") }}>
            {busy ? "Reconciling…" : journal?.postFunding?.fundingProof ? "Resume funding verification" : "Verify funding & notify seller"}
          </button> : null}
          {journal?.postFunding?.lastStatus && lifecycle.canCheck ? <button className="hire__secondary" type="button" disabled={busy} onClick={() => { void syncLifecycle("hire-status") }}>
            {busy ? "Checking…" : journal.postFunding.statusProof ? "Check live status" : "Authorize live status"}
          </button> : null}
        </div>
        <p className="hire-lifecycle__boundary">Status checks use a scoped EOA signature and never send a transaction. Reloading this page restores the saved authorization and last verified state.</p>
      </section> : null}
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
