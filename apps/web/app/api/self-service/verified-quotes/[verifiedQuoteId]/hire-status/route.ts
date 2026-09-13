import { handleHireLifecycle } from "../../../../../../src/server-hire-lifecycle.ts"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: Request, context: { params: Promise<{ verifiedQuoteId: string }> }): Promise<Response> {
  const { verifiedQuoteId } = await context.params
  return handleHireLifecycle(request, verifiedQuoteId, "READ_HIRE_STATUS", "hire-status")
}
