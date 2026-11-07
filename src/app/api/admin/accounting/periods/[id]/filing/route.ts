import { filingBodySchema } from '@/lib/accounting/accounting-schema';
import { updatePeriodFiling } from '@/lib/accounting/accounting-store';
import { handleAccountingWrite, type AccountingContext } from '@/lib/accounting/accounting-route';

/** 期間の申告の設定（法人税・消費税の延長、課税事業者か免税事業者か・課税事業者になった日）。admin.accounting.settings.manage。 */
export async function PUT(request: Request, context: AccountingContext): Promise<Response> {
	return handleAccountingWrite(request, context, {
		label: 'PUT /api/admin/accounting/periods/[id]/filing',
		action: 'admin.accounting.period.filing',
		withId: true,
		status: 200,
		schema: filingBodySchema,
		run: (client, actorId, id, body) => updatePeriodFiling(client, actorId, { ...body, periodId: id as string }),
		audit: (period) => ({ resourceId: period.id, metadata: { period_id: period.id, result_code: 'ok' } }),
		respond: async (_client, period) => ({ period }),
	});
}
