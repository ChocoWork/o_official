import { handleReturnOptionsGet, handleReturnOptionsPut } from '@/lib/accounting/return-refund-route';

/** 返品の届いた日に運送会社の配達日を使う設定（既定オフ）。admin.finance.read、全応答 no-store。 */
export async function GET(request: Request): Promise<Response> {
	return handleReturnOptionsGet(request);
}

/** 設定を切り替える（版つき）。admin.accounting.settings.manage。監査は結果だけ。 */
export async function PUT(request: Request): Promise<Response> {
	return handleReturnOptionsPut(request);
}
