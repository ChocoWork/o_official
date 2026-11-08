import { handleYearEndCheckPost, handleYearEndGet, handleYearEndOptionsPut } from '@/lib/accounting/posting-route';

/** 年末の発送票の一覧（確かめた印・受付日とのずれ・設定つき）。admin.finance.read、全応答 no-store。 */
export async function GET(request: Request): Promise<Response> {
	return handleYearEndGet(request);
}

/** 確かめた印を付ける。admin.finance.manage。 */
export async function POST(request: Request): Promise<Response> {
	return handleYearEndCheckPost(request);
}

/** 運送会社の受付日の照らし合わせのオン・オフ。admin.accounting.settings.manage。 */
export async function PUT(request: Request): Promise<Response> {
	return handleYearEndOptionsPut(request);
}
