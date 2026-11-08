import { handleDisputeAssign } from '@/lib/accounting/posting-route';
import type { AccountingContext } from '@/lib/accounting/accounting-route';

/** 確定・科目の決定待ちの振り替え。admin.accounting.entries.correct。[id] は Stripe の取り消しの番号（dp_…）。 */
export async function POST(request: Request, context: AccountingContext): Promise<Response> {
	return handleDisputeAssign(request, context);
}
