import { finalSoleBodySchema } from '@/lib/accounting/accounting-schema';
import { getAccountingSettings, listAccountingPeriods, shortenFinalSolePeriod } from '@/lib/accounting/accounting-store';
import { handleAccountingWrite, type AccountingContext } from '@/lib/accounting/accounting-route';

/**
 * 個人の最後の期間をやめた日までにする（選び直しは理由が要る）。admin.accounting.settings.manage。
 * 成功後は期間と設定を読み直して返す。読み直しに失敗しても書き込みは済んでいるので、期間だけを返す。
 */
export async function POST(request: Request, context: AccountingContext): Promise<Response> {
	return handleAccountingWrite(request, context, {
		label: 'POST /api/admin/accounting/periods/[id]/final-sole',
		action: 'admin.accounting.period.final_sole',
		withId: true,
		status: 200,
		schema: finalSoleBodySchema,
		run: (client, actorId, id, body) =>
			shortenFinalSolePeriod(client, actorId, {
				periodId: id as string,
				endedOn: body.endedOn,
				expectedPeriodVersion: body.expectedPeriodVersion,
				expectedSettingsVersion: body.expectedSettingsVersion,
				reason: body.reason ?? null,
				requestKey: body.requestKey,
			}),
		audit: (period) => ({ resourceId: period.id, metadata: { period_id: period.id, result_code: 'ok' } }),
		respond: async (client, period) => {
			try {
				const periods = await listAccountingPeriods(client);
				const settings = await getAccountingSettings(client);
				return { period, periods, settings };
			} catch {
				return { period };
			}
		},
	});
}
