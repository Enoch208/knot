import type { Metadata } from "next"
import GuidedDemo from "../../src/GuidedDemo"

export const metadata: Metadata = {
  title: "Guided job lifecycle demo — KNOT",
  description: "Follow retained BSC testnet jobs from escrow funding through delivery, artifact evidence, and settlement or refund.",
}

export default async function GuidedDemoPage({
  searchParams,
}: {
  searchParams: Promise<{ job?: string | string[] }>
}) {
  const requested = (await searchParams).job
  return <GuidedDemo requestedJobId={typeof requested === "string" ? requested : undefined} />
}
