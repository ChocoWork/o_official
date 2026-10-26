import { handleAllocationSwap } from '@/lib/inventory/allocation-swap-route';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleAllocationSwap(request, context);
}
