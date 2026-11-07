import { settingsBodySchema } from '@/lib/accounting/accounting-schema';
import { getAccountingSettings, updateAccountingSettings } from '@/lib/accounting/accounting-store';
import { handleAccountingWrite, handleSettingsGet } from '@/lib/accounting/accounting-route';
import type { AccountingSettings } from '@/lib/accounting/accounting-types';

/** 会計の設定。admin.finance.read、全応答 no-store。 */
export async function GET(request: Request): Promise<Response> {
	return handleSettingsGet(request);
}

const AUDITED_FIELDS = ['businessStartDate', 'currentBusinessType'] as const;

/**
 * 開業日（1度だけ）と今の事業の形。admin.accounting.settings.manage。
 * 監査には変わった項目の名前だけを載せ、値（開業日など）は載せない。
 */
export async function PUT(request: Request): Promise<Response> {
	return handleAccountingWrite(request, null, {
		label: 'PUT /api/admin/accounting/settings',
		action: 'admin.accounting.settings.update',
		withId: false,
		status: 200,
		schema: settingsBodySchema,
		run: async (client, actorId, _id, body): Promise<{ before: AccountingSettings; after: AccountingSettings }> => {
			const before = await getAccountingSettings(client);
			const after = await updateAccountingSettings(client, actorId, body);
			return { before, after };
		},
		audit: ({ before, after }) => ({
			resourceId: null,
			metadata: { changed_fields: AUDITED_FIELDS.filter((field) => before[field] !== after[field]) },
		}),
		respond: async (_client, { after }) => ({ settings: after }),
	});
}
