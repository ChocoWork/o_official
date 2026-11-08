import { handleStripeInvoiceGet, handleStripeInvoicePut } from '@/lib/accounting/posting-route';

/** 月の適格請求書の記録。admin.finance.read、全応答 no-store。 */
export async function GET(request: Request): Promise<Response> {
	return handleStripeInvoiceGet(request);
}

/** 適格請求書の合計の記録（版つき）。admin.finance.manage。監査は月と結果だけで、金額を入れない。 */
export async function PUT(request: Request): Promise<Response> {
	return handleStripeInvoicePut(request);
}
