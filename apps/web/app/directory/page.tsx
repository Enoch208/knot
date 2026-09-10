import type { Metadata } from "next"
import { directorySnapshot, shortAddress } from "../../src/directory"
import "../../src/styles/directory.css"

export const metadata: Metadata = {
  title: "Registry directory — KNOT",
  description:
    "A sampled page of the BNB Chain ERC-8004 registry, with every published field labelled by provenance.",
}

const { aggregates, entries, sampleSize, registeredTotal, observedAtUtc, requestUri, coverageStatement } =
  directorySnapshot

const findings = [
  {
    figure: `${aggregates.claimedNames} / ${sampleSize}`,
    label: "Names are publisher-claimed",
    note: "registry metadata, verified by nobody",
  },
  {
    figure: `${aggregates.withAnyFeedback} / ${sampleSize}`,
    label: "Carry any feedback",
    note: "no counterparty has recorded an outcome",
  },
  {
    figure: `${aggregates.withAnyScore} / ${sampleSize}`,
    label: "Carry any score",
    note: "there is no reputation to rank on",
  },
  {
    figure: `${aggregates.defaultScaffoldNames} / ${sampleSize}`,
    label: "Still named studio-agent",
    note: "the unedited scaffold default",
  },
]

export default function DirectoryPage() {
  return (
    <main className="directory-page">
      <header className="directory-intro">
        <p className="directory-kicker">Registry directory</p>
        <h1>
          {registeredTotal.toLocaleString("en-US")} registered.
          <br />
          Almost nothing published.
        </h1>
        <p>
          A directory can list every agent on the chain and still leave a buyer unable to choose.
          This is one sampled page of the ERC-8004 index with every field labelled by where it came
          from — not a ranking, because there is nothing here to rank on.
        </p>
      </header>

      <section className="directory-findings" aria-label="What the sample shows">
        {findings.map((finding) => (
          <div key={finding.label}>
            <strong>{finding.figure}</strong>
            <span>{finding.label}</span>
            <small>{finding.note}</small>
          </div>
        ))}
      </section>

      <section className="directory-listing" aria-label="Sampled agents">
        <div className="directory-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Name</th>
                <th scope="col">Owner</th>
                <th scope="col">Feedback</th>
                <th scope="col">Score</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.agentId}>
                  <th scope="row">
                    <code>#{entry.agentId}</code>
                    {entry.knotVerified ? <em>KNOT-verified</em> : null}
                  </th>
                  <td>
                    <span>{entry.name}</span>
                    <small className="directory-provenance">{entry.nameProvenance}</small>
                  </td>
                  <td className="numeric">{shortAddress(entry.ownerAddress)}</td>
                  <td className="numeric">{entry.feedbackCount ?? "unavailable"}</td>
                  <td className="numeric">
                    {entry.averageScore === null ? "unavailable" : entry.averageScore}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="directory-coverage">
        <p>{coverageStatement}</p>
        <p className="directory-source">
          Sampled {sampleSize} of {registeredTotal.toLocaleString("en-US")} on BSC testnet ·{" "}
          {observedAtUtc.slice(0, 19).replace("T", " ")} UTC · <code>{requestUri}</code>
        </p>
      </footer>
    </main>
  )
}
