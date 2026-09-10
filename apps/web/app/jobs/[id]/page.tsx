import type { Metadata } from "next"
import { notFound } from "next/navigation"
import JobRecordDetail from "../../../src/JobRecord"
import { findJobRecord, jobRecords, outcomeOf } from "../../../src/job-records"

type PageProperties = { params: Promise<{ id: string }> }

export function generateStaticParams() {
  return jobRecords.map((job) => ({ id: job.jobId }))
}

export async function generateMetadata({ params }: PageProperties): Promise<Metadata> {
  const job = findJobRecord((await params).id)
  if (job === null) return { title: "Job record not found — KNOT" }
  const outcome = outcomeOf(job)
  return {
    title: `Job ${job.jobId} record — KNOT`,
    description: `${job.agent.name ?? `Agent ${job.agent.agentId}`} on ${job.network.name}: ${
      outcome?.label ?? job.settlement.terminalState
    }.`,
  }
}

export default async function JobRecordPage({ params }: PageProperties) {
  const job = findJobRecord((await params).id)
  if (job === null) notFound()
  return <JobRecordDetail job={job} />
}
