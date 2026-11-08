import { handlePendingResolve } from '@/lib/accounting/posting-route';
import type { AccountingContext } from '@/lib/accounting/accounting-route';

/**
 * 計上待ちを確認済みにする（切り替えより前・額0の物だけ。お金の動く物は DB が断る）。admin.accounting.entries.correct。
 * 監査は対象の番号と結果だけで、メモの本文を入れない。
 */
export async function POST(request: Request, context: AccountingContext): Promise<Response> {
	return handlePendingResolve(request, context);
}
