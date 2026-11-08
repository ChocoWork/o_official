import { handleDisputeSettingPut, handleDisputeSettingsGet } from '@/lib/accounting/posting-route';

/** 原因ごとの振り替え先の科目。admin.finance.read、全応答 no-store。 */
export async function GET(request: Request): Promise<Response> {
	return handleDisputeSettingsGet(request);
}

/** 振り替え先の科目を入れる・変える。admin.accounting.settings.manage。監査は原因と勘定の符号だけ。 */
export async function PUT(request: Request): Promise<Response> {
	return handleDisputeSettingPut(request);
}
