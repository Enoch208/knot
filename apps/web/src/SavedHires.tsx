"use client"

import { useEffect, useState } from "react"
import { HirePanel } from "./HirePanel"
import { readSavedHireIds } from "./hire-journal"

export function SavedHires({ currentQuoteId }: { currentQuoteId: string | undefined }) {
  const [ids, setIds] = useState<string[]>([])
  const [unreadable, setUnreadable] = useState(false)
  useEffect(() => {
    try { setIds(readSavedHireIds(localStorage)); setUnreadable(false) }
    catch { setUnreadable(true) }
  }, [currentQuoteId])
  if (unreadable) return <p role="alert">Saved hire recovery is unavailable. Do not clear site data or start a replacement for an unresolved transaction.</p>
  const previous = ids.filter(id => id !== currentQuoteId)
  if (previous.length === 0) return null
  return <section aria-label="Saved hires">
    <h2>Recover a saved hire</h2>
    {previous.map(id => <details key={id}><summary>{id}</summary><HirePanel verifiedQuoteId={id} /></details>)}
  </section>
}
