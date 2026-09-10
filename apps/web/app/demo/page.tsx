import type { Metadata } from "next"
import DemoExperience from "../../src/DemoExperience"

export const metadata: Metadata = {
  title: "Verified quote demo — KNOT",
  description:
    "Run a safe KNOT example and inspect a fresh, task-bound BSC testnet quote before funding.",
}

export default function DemoPage() {
  return <DemoExperience />
}

