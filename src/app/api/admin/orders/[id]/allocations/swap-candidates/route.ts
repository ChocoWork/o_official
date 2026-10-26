import { handleAllocationSwapCandidates } from '@/lib/inventory/allocation-swap-route';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleAllocationSwapCandidates(request, context);
}
