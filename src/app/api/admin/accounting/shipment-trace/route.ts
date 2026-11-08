import { handleShipmentTraceGet } from '@/lib/accounting/posting-route';

/** 発送票の直した跡と仕訳。admin.finance.read、全応答 no-store。 */
export async function GET(request: Request): Promise<Response> {
	return handleShipmentTraceGet(request);
}
