import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

const headers = { "Cache-Control": "no-store, max-age=0" }

export async function GET() {
  try {
    const response = await fetch("https://knot-api.truematchx.com/api/status", {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(4_000),
    })
    if (!response.ok) throw new Error("upstream status unavailable")

    const body = (await response.json()) as {
      status?: unknown
      checkedAt?: unknown
      dependencies?: { database?: unknown }
    }
    const available =
      body.status === "AVAILABLE" && body.dependencies?.database === "AVAILABLE"

    return NextResponse.json(
      {
        status: available ? "AVAILABLE" : "UNAVAILABLE",
        checkedAt: typeof body.checkedAt === "string" ? body.checkedAt : null,
      },
      { status: available ? 200 : 503, headers },
    )
  } catch {
    return NextResponse.json(
      { status: "UNAVAILABLE", checkedAt: null },
      { status: 503, headers },
    )
  }
}
