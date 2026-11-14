import { handlePendingLinkEntry } from '@/lib/accounting/posting-route';
import type { AccountingContext } from '@/lib/accounting/accounting-route';

/**
 * 手で入れる待ち（order_not_postable）を、手で入れた仕訳と結んで閉じる。admin.accounting.entries.correct。
 * 監査は対象の番号と結果だけで、メモの本文・仕訳の番号・額を入れない。
 */
export async function POST(request: Request, context: AccountingContext): Promise<Response> {
	return handlePendingLinkEntry(request, context);
}
