import { createPeriodBodySchema } from '@/lib/accounting/accounting-schema';
import { createAccountingPeriod } from '@/lib/accounting/accounting-store';
import { handleAccountingWrite, handlePeriodsGet } from '@/lib/accounting/accounting-route';

/** 会計の期間の一覧と、期間ごとの申告の期限・中間申告・開業日からの期限。admin.finance.read、全応答 no-store。 */
export async function GET(request: Request): Promise<Response> {
	return handlePeriodsGet(request);
}

/** 期間の作成。admin.accounting.settings.manage。名前はサーバーが作る。再送は同じ requestKey で同じ本文（201）。 */
export async function POST(request: Request): Promise<Response> {
	return handleAccountingWrite(request, null, {
		label: 'POST /api/admin/accounting/periods',
		action: 'admin.accounting.period.create',
		withId: false,
		status: 201,
		schema: createPeriodBodySchema,
		run: (client, actorId, _id, body) => createAccountingPeriod(client, actorId, body),
		audit: (period) => ({ resourceId: period.id, metadata: { period_id: period.id, result_code: 'ok' } }),
		respond: async (_client, period) => ({ period }),
	});
}
