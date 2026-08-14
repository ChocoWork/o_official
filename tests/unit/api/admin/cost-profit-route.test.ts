jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: jest.fn().mockResolvedValue(undefined) }));
jest.mock('next/server', () => ({
	NextResponse: {
		json: (body: unknown, init?: { status?: number }) => ({
			status: init?.status ?? 200,
			json: async () => body,
		}),
	},
}));

import { GET, POST } from '@/app/api/admin/kpi/cost-profit/route';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';

const authorizeMock = authorizeAdminPermission as jest.MockedFunction<typeof authorizeAdminPermission>;
const createServiceMock = createServiceRoleClient as jest.MockedFunction<typeof createServiceRoleClient>;

const ADMIN = {
	ok: true as const,
	userId: 'admin-id',
	role: 'admin' as const,
	actorEmail: 'admin@example.com',
};

// 会計は暦年（1/1〜12/31）で切る。シーズンは商品原価の絞り込みにのみ使う任意パラメータ。
// GET は 9 本のクエリを Promise.all で並べるため、テーブル名ごとに終端の thenable を返す。
let financeQueryError: { code: string; message: string } | null = null;
let cumulativeRowsOverride: Array<Record<string, unknown>> | null = null;
let cumulativeRangeCalls: Array<[number, number]> = [];
let cumulativePageLimit: number | null = null;

function result(data: unknown) {
	return Promise.resolve({ data, error: financeQueryError });
}

function createFinanceSupabaseMock() {
	return {
		from: jest.fn((table: string) => {
			if (table === 'admin_finance_years') {
				return {
					select: () => ({
						eq: () => ({
							maybeSingle: () =>
								result({
									fiscal_year: 2026,
									business_type: 'soleProprietor',
									sales_revenue: 3240000,
									opening_cash: 420000,
									accounts_receivable: 324000,
									fixed_assets: 260000,
									accounts_payable: 430000,
									opening_capital: 1091000,
								}),
						}),
					}),
				};
			}

			if (table === 'admin_finance_expenses') {
				const rows = cumulativeRowsOverride ?? [
					{
						id: 1,
						entry_type: 'expense',
						expense_date: '2026-05-24',
						category: '広告宣伝費',
						item_name: 'Instagram広告費',
						partner: '丸善テキスタイル',
						amount: 32000,
						payment_method: 'クレジットカード',
						memo: '広告',
						season_key: null,
						admin_finance_receipts: [],
					},
					{
						id: 2,
						entry_type: 'income',
						expense_date: '2026-05-25',
						category: '売上高',
						item_name: 'オンライン販売',
						partner: '',
						amount: 120000,
						payment_method: '銀行',
						memo: '',
						season_key: null,
						admin_finance_receipts: [],
						admin_finance_evidence_unavailable_records: {
							reason: 'bank_history_expired',
							note: '銀行へ照会したが取得できず',
							recorded_at: '2026-08-14T01:00:00.000Z',
							recorded_by: 'admin-id',
							updated_at: '2026-08-14T01:00:00.000Z',
							updated_by: 'admin-id',
						},
					},
				];

				return {
					select: () => ({
						// 当年度の取引一覧：fiscal_year で絞り、論理削除を除外して並べ替える
						eq: () => ({
							is: () => ({
								order: () => ({ order: () => result(rows) }),
							}),
						}),
						// 開業以来累計：選択年度の年末までを取る
						lte: () => ({
							is: () => ({
								order: () => ({ order: () => ({ range: (from: number, to: number) => {
									cumulativeRangeCalls.push([from, to]);
									return Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + (cumulativePageLimit ?? Number.MAX_SAFE_INTEGER))), count: rows.length, error: financeQueryError });
								} }) }),
							}),
						}),
					}),
				};
			}

			if (table === 'orders') {
				return {
					select: () => ({
						gte: () => ({
							lt: () => ({
								order: () => ({
									order: () => result([
										{
											id: 'order-1',
											payment_intent_id: 'pi_1',
											status: 'paid',
											total_amount: 25_300,
											refunded_amount: 500,
											currency: 'jpy',
											created_at: '2026-05-26T01:00:00.000Z',
										},
										{
											id: 'order-fully-refunded',
											payment_intent_id: 'pi_refunded',
											status: 'cancelled',
											total_amount: 59_600,
											refunded_amount: 59_600,
											currency: 'jpy',
											created_at: '2026-07-05T01:00:00.000Z',
										},
									]),
								}),
							}),
						}),
					}),
				};
			}

			if (table === 'admin_finance_partners') {
				return { select: () => ({ order: () => result([{ id: 1, name: '丸善テキスタイル' }]) }) };
			}

			if (table === 'admin_finance_expense_templates') {
				return {
					select: () => ({
						order: () =>
							result([
								{
									name: '毎月の家賃',
									entry_type: 'expense',
									category: '地代家賃',
									item_name: '打合せ・交通',
									partner: null,
									amount: 80000,
									payment_method: '銀行',
									memo: '事務所',
								},
							]),
					}),
				};
			}

			if (table === 'admin_finance_summary_options') {
				return { select: () => ({ order: () => result([{ id: 11, entry_type: 'expense', name: '外注検品' }]) }) };
			}

			if (table === 'admin_finance_fixed_assets') {
				return { select: () => ({ order: () => ({ order: () => result([]) }) }) };
			}

			if (table === 'admin_finance_year_closings') {
				return { select: () => ({ in: () => result([]) }) };
			}

			if (table === 'admin_finance_entry_revisions') {
				return { select: () => ({ order: () => ({ order: () => ({ limit: () => result([]) }) }) }) };
			}

			// admin_product_costs（シーズン指定時のみ引かれる）
			return {
				select: () => ({
					eq: () => ({
						order: () =>
							result([
								{
									sku: 'LFDH-SS26-T001',
									name: 'ドローストリングシャツ',
									category: 'トップス',
									production_method: '国内縫製',
									planned_quantity: 60,
									selling_price: 24800,
									material_cost: 3200,
									sewing_cost: 3000,
									pattern_cost: 500,
									accessories_cost: 800,
									processing_cost: 600,
									finishing_cost: 900,
								},
							]),
					}),
				}),
			};
		}),
	};
}

describe('GET /api/admin/kpi/cost-profit', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		financeQueryError = null;
		cumulativeRowsOverride = null;
		cumulativeRangeCalls = [];
		cumulativePageLimit = null;
		authorizeMock.mockResolvedValue(ADMIN);
		createServiceMock.mockResolvedValue(createFinanceSupabaseMock() as never);
	});

	it('管理者へ指定年度の会計データを返す', async () => {
		const response = await GET(new Request('http://localhost/api/admin/kpi/cost-profit?year=2026'));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.data.fiscalYear).toBe(2026);
		expect(body.data.businessType).toBe('soleProprietor');
		expect(body.data.plan.salesRevenue).toBe(3240000);
		// entry_type で支出・収入に振り分けられる。
		expect(body.data.expenses).toHaveLength(1);
		expect(body.data.expenses[0].item).toBe('Instagram広告費');
		expect(body.data.expenses[0].partner).toBe('丸善テキスタイル');
		expect(body.data.incomes).toHaveLength(2);
		expect(body.data.incomes[0].item).toBe('オンライン販売');
		expect(body.data.incomes[0].entryType).toBe('income');
		expect(body.data.incomes[0].evidenceUnavailable).toEqual({
			reason: 'bank_history_expired',
			note: '銀行へ照会したが取得できず',
			recordedAt: '2026-08-14T01:00:00.000Z',
			recordedBy: 'admin-id',
			updatedAt: '2026-08-14T01:00:00.000Z',
			updatedBy: 'admin-id',
		});
		expect(body.data.incomes[1]).toEqual(expect.objectContaining({
			entryType: 'income',
			category: '売上高',
			item: 'オンライン注文',
			amount: 24_800,
			source: 'order',
			evidenceStatus: 'system_record',
			sourceId: 'order-1',
			readOnly: true,
			grossAmount: 25_300,
			refundedAmount: 500,
		}));
		expect(body.data.partners).toEqual(['丸善テキスタイル']);
		expect(body.data.cumulativeEntries[0]).toEqual(expect.objectContaining({
			id: 1,
			entryType: 'expense',
			date: '2026-05-24',
			category: '広告宣伝費',
			item: 'Instagram広告費',
			partner: '丸善テキスタイル',
			amount: 32000,
			paymentMethod: 'クレジットカード',
		}));
		expect(body.data.templates).toEqual([
			{ name: '毎月の家賃', entryType: 'expense', category: '地代家賃', item: '打合せ・交通', partner: '', amount: 80000, paymentMethod: '銀行', memo: '事務所' },
		]);
		expect(authorizeMock).toHaveBeenCalledWith('admin.finance.read', expect.any(Request));
	});

	it('会計テーブルが未作成でも初回利用の空データを返す', async () => {
		financeQueryError = {
			code: '42P01',
			message: 'relation "admin_finance_expenses" does not exist',
		};

		const response = await GET(new Request('http://localhost/api/admin/kpi/cost-profit?year=2026'));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.data.fiscalYear).toBe(2026);
		expect(body.data.expenses).toEqual([]);
		expect(body.data.incomes).toEqual([]);
		expect(body.data.fixedAssets).toEqual([]);
		expect(body.data.plan).toEqual({
			salesRevenue: 0,
			openingCash: 0,
			accountsReceivable: 0,
			fixedAssets: 0,
			accountsPayable: 0,
			openingCapital: 0,
		});
	});

	it('年度が無ければ拒否する', async () => {
		const response = await GET(new Request('http://localhost/api/admin/kpi/cost-profit'));
		expect(response.status).toBe(400);
	});

	it('不正な年度を拒否する', async () => {
		const response = await GET(new Request('http://localhost/api/admin/kpi/cost-profit?year=notayear'));
		expect(response.status).toBe(400);
	});

	it('シーズンを指定しなければ商品原価は引かない', async () => {
		const response = await GET(new Request('http://localhost/api/admin/kpi/cost-profit?year=2026'));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.data.products).toEqual([]);
	});

	it('シーズンを指定しても商品原価は専用APIへ委譲する', async () => {
		const response = await GET(new Request('http://localhost/api/admin/kpi/cost-profit?year=2026&season=2026SS'));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.data.products).toEqual([]);
	});

	it('不正なシーズンキーを拒否する', async () => {
		const response = await GET(new Request('http://localhost/api/admin/kpi/cost-profit?year=2026&season=invalid'));
		expect(response.status).toBe(400);
	});

	it('累積取引はmax_rows相当500件でも1001件を全件返す', async () => {
		cumulativePageLimit = 500;
		cumulativeRowsOverride = Array.from({ length: 1001 }, (_, index) => ({
			id: index + 1, entry_type: index % 2 === 0 ? 'income' : 'expense',
			expense_date: `2026-01-${String((index % 28) + 1).padStart(2, '0')}`,
			category: 'テスト', item_name: `取引${index + 1}`, partner: '', amount: index + 1, payment_method: '銀行',
		}));
		const response = await GET(new Request('http://localhost/api/admin/kpi/cost-profit?year=2026'));
		const body = await response.json();
		expect(body.data.cumulativeEntries).toHaveLength(1001);
		expect(body.data.cumulativeEntries.at(-1)).toEqual(expect.objectContaining({ id: 1001 }));
		expect(cumulativeRangeCalls).toEqual([[0, 999], [500, 1499], [1000, 1999]]);
	});
});

describe('POST /api/admin/kpi/cost-profit', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		authorizeMock.mockResolvedValue(ADMIN);
	});

	it('取引の削除は物理削除ではなく論理削除にする', async () => {
		// 電子帳簿保存法の真実性の要件。行は残し deleted_at を立てる。
		const select = jest.fn().mockResolvedValue({ data: [{ id: 12 }], error: null });
		const isNull = jest.fn().mockReturnValue({ select });
		const yearEq = jest.fn().mockReturnValue({ is: isNull });
		const idEq = jest.fn().mockReturnValue({ eq: yearEq });
		const update = jest.fn().mockReturnValue({ eq: idEq });
		const allocationLimit = jest.fn().mockResolvedValue({ data: [], error: null });
		const from = jest.fn((table: string) => table === 'admin_expense_cost_allocations'
			? { select: () => ({ eq: () => ({ limit: allocationLimit }) }) }
			: { update });

		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ operation: 'expense.delete', fiscalYear: 2026, expenseId: 12 }),
		}));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(from).toHaveBeenCalledWith('admin_finance_expenses');
		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({ deleted_by: 'admin-id', updated_by: 'admin-id' }),
		);
		expect(idEq).toHaveBeenCalledWith('id', 12);
		expect(yearEq).toHaveBeenCalledWith('fiscal_year', 2026);
		expect(isNull).toHaveBeenCalledWith('deleted_at', null);
	});

	it('該当する取引が無ければ404を返す', async () => {
		const select = jest.fn().mockResolvedValue({ data: [], error: null });
		const from = jest.fn((table: string) => table === 'admin_expense_cost_allocations'
			? { select: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }) }
			: { update: () => ({ eq: () => ({ eq: () => ({ is: () => ({ select }) }) }) }) });
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ operation: 'expense.delete', fiscalYear: 2026, expenseId: 999 }),
		}));

		expect(response.status).toBe(404);
	});

	it('収入（entryType=income）を entry_type 付きで登録する', async () => {
		const yearUpsert = jest.fn().mockResolvedValue({ error: null });
		const single = jest.fn().mockResolvedValue({ data: { id: 5, fiscal_year: 2026 }, error: null });
		const select = jest.fn().mockReturnValue({ single });
		const insert = jest.fn().mockReturnValue({ select });
		const from = jest.fn((table: string) =>
			table === 'admin_finance_years' ? { upsert: yearUpsert } : { insert },
		);
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				operation: 'expense.create',
				fiscalYear: 2026,
				expense: { entryType: 'income', date: '2026-05-25', category: '売上高', item: 'オンライン販売', amount: 120000, paymentMethod: '銀行' },
			}),
		}));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		// 年度レコードを先に用意してから取引を挿す。
		expect(yearUpsert).toHaveBeenCalledWith(
			{ fiscal_year: 2026 },
			{ onConflict: 'fiscal_year', ignoreDuplicates: true },
		);
		expect(insert).toHaveBeenCalledWith(
			expect.objectContaining({ entry_type: 'income', item_name: 'オンライン販売', amount: 120000 }),
		);
	});

	it('取引先マスタへ新規取引先をupsertする', async () => {
		const upsert = jest.fn().mockResolvedValue({ error: null });
		const from = jest.fn().mockReturnValue({ upsert });
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ operation: 'partner.create', partnerName: '丸善テキスタイル' }),
		}));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(from).toHaveBeenCalledWith('admin_finance_partners');
		expect(upsert).toHaveBeenCalledWith(
			{ name: '丸善テキスタイル', created_by: 'admin-id' },
			{ onConflict: 'name', ignoreDuplicates: true },
		);
	});

	it('新規テンプレートをinsertする', async () => {
		const insert = jest.fn().mockResolvedValue({ error: null });
		const from = jest.fn().mockReturnValue({ insert });
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				operation: 'template.create',
				template: { name: '毎月の家賃', entryType: 'expense', category: '地代家賃', item: '打合せ・交通', partner: '不動産会社', amount: 80000, paymentMethod: '銀行', memo: '事務所' },
			}),
		}));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(from).toHaveBeenCalledWith('admin_finance_expense_templates');
		expect(insert).toHaveBeenCalledWith(
			{
				name: '毎月の家賃',
				entry_type: 'expense',
				category: '地代家賃',
				item_name: '打合せ・交通',
				partner: '不動産会社',
				amount: 80000,
				payment_method: '銀行',
				memo: '事務所',
				created_by: 'admin-id',
			},
		);
	});

	it('新規テンプレートの名前が重複した場合は409を返す', async () => {
		const insert = jest.fn().mockResolvedValue({ error: { code: '23505', message: 'duplicate key' } });
		const from = jest.fn().mockReturnValue({ insert });
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				operation: 'template.create',
				template: { name: '毎月の家賃', entryType: 'expense', category: '地代家賃', item: '打合せ・交通', partner: '不動産会社', amount: 80000, paymentMethod: '銀行', memo: '事務所' },
			}),
		}));

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: '同じ名前のテンプレートが存在します。' });
	});

	it('選択中のテンプレートだけを現在の入力内容で更新する', async () => {
		const maybeSingle = jest.fn().mockResolvedValue({ data: { name: '毎月の家賃' }, error: null });
		const select = jest.fn().mockReturnValue({ maybeSingle });
		const eq = jest.fn().mockReturnValue({ select });
		const update = jest.fn().mockReturnValue({ eq });
		const from = jest.fn().mockReturnValue({ update });
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				operation: 'template.update',
				templateName: '毎月の家賃',
				template: { name: '毎月の家賃', entryType: 'expense', category: '地代家賃', item: '事務所家賃', partner: '新しい不動産会社', amount: 85000, paymentMethod: '銀行', memo: '更新後' },
			}),
		}));

		expect(response.status).toBe(200);
		expect(update).toHaveBeenCalledWith(expect.objectContaining({ item_name: '事務所家賃', partner: '新しい不動産会社', amount: 85000, memo: '更新後' }));
		expect(eq).toHaveBeenCalledWith('name', '毎月の家賃');
	});

	it('上書き対象のテンプレートが存在しない場合は404を返す', async () => {
		const maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
		const select = jest.fn().mockReturnValue({ maybeSingle });
		const eq = jest.fn().mockReturnValue({ select });
		const update = jest.fn().mockReturnValue({ eq });
		createServiceMock.mockResolvedValueOnce({ from: jest.fn().mockReturnValue({ update }) } as never);

		const response = await POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST',
			body: JSON.stringify({
				operation: 'template.update',
				templateName: '削除済みテンプレート',
				template: { name: '削除済みテンプレート', entryType: 'expense', category: '地代家賃', item: '事務所家賃', amount: 85000, paymentMethod: '銀行', memo: '' },
			}),
		}));

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: 'テンプレートが見つかりません。選択し直してください。' });
	});

	it('共有摘要候補を正規化して追加する', async () => {
		const single = jest.fn().mockResolvedValue({ data: { id: 8, entry_type: 'expense', name: '撮影立会費' }, error: null });
		const select = jest.fn().mockReturnValue({ single });
		const insert = jest.fn().mockReturnValue({ select });
		const from = jest.fn().mockReturnValue({ insert });
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST', body: JSON.stringify({ operation: 'summaryOption.create', entryType: 'expense', name: ' 撮影立会費 ' }),
		}));

		expect(response.status).toBe(200);
		expect(insert).toHaveBeenCalledWith(expect.objectContaining({ entry_type: 'expense', name: '撮影立会費' }));
	});

	it('使用中の共有摘要候補は削除しない', async () => {
		const from = jest.fn((table: string) => {
			if (table === 'admin_finance_summary_options') return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 8, entry_type: 'expense', name: '撮影立会費' }, error: null }) }) }) };
			if (table === 'admin_finance_expenses') return { select: () => ({ eq: () => ({ eq: () => ({ is: () => ({ limit: () => Promise.resolve({ data: [{ id: 1 }], error: null }) }) }) }) }) };
			return { select: () => ({ eq: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }) }) };
		});
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST', body: JSON.stringify({ operation: 'summaryOption.delete', summaryOptionId: 8 }),
		}));

		expect(response.status).toBe(409);
		expect((await response.json()).error).toContain('使用中');
	});

	it('法人の訂正内容を確認済みにできる', async () => {
		const upsert = jest.fn().mockResolvedValue({ error: null });
		const from = jest.fn().mockReturnValue({ upsert });
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				operation: 'entry.reviewAck',
				entryRef: 'entry:28',
				reason: 'revisedEntry',
				acknowledged: true,
				note: '訂正前後と証憑を確認',
			}),
		}));

		expect(response.status).toBe(200);
		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				entry_ref: 'entry:28',
				reason: 'revisedEntry',
			}),
			{ onConflict: 'entry_ref,reason' },
		);
	});
});

// FREQ-260: 固定資産と購入取引の連携。
// 取得価額・取得日は取引が単一の情報源で、台帳はサーバー側で取引に追随させる。
describe('POST /api/admin/kpi/cost-profit（証憑添付不可）', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		authorizeMock.mockResolvedValue(ADMIN);
	});

	it('手動収入へ証憑添付不可の理由を保存する', async () => {
		const upsert = jest.fn().mockResolvedValue({ error: null });
		const from = jest.fn((table: string) => {
			if (table === 'admin_finance_expenses') {
				return {
					select: () => ({
						eq: () => ({
							is: () => ({
								maybeSingle: () => Promise.resolve({
									data: { entry_type: 'income', deleted_at: null },
									error: null,
								}),
							}),
						}),
					}),
				};
			}
			return { upsert };
		});
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				operation: 'evidenceUnavailable.upsert',
				expenseId: 2,
				reason: 'bank_history_expired',
				note: '銀行へ過去明細を照会したが取得できず',
			}),
		}));

		expect(response.status).toBe(200);
		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				entry_id: 2,
				reason: 'bank_history_expired',
				note: '銀行へ過去明細を照会したが取得できず',
				recorded_by: 'admin-id',
				updated_by: 'admin-id',
			}),
			{ onConflict: 'entry_id' },
		);
	});

	it('銀行の閲覧期限超過は補足メモなしで保存できない', async () => {
		const response = await POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				operation: 'evidenceUnavailable.upsert',
				expenseId: 2,
				reason: 'bank_history_expired',
				note: '',
			}),
		}));

		expect(response.status).toBe(400);
	});

	it('支出には証憑添付不可を保存できない', async () => {
		const from = jest.fn(() => ({
			select: () => ({
				eq: () => ({
					is: () => ({
						maybeSingle: () => Promise.resolve({
							data: { entry_type: 'expense', deleted_at: null },
							error: null,
						}),
					}),
				}),
			}),
		}));
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				operation: 'evidenceUnavailable.upsert',
				expenseId: 1,
				reason: 'not_issued',
				note: '',
			}),
		}));

		expect(response.status).toBe(400);
	});

	it('証憑添付不可の記録を解除する', async () => {
		const removeEq = jest.fn().mockResolvedValue({ error: null });
		const from = jest.fn((table: string) => {
			if (table === 'admin_finance_expenses') {
				return {
					select: () => ({
						eq: () => ({
							is: () => ({
								maybeSingle: () => Promise.resolve({
									data: { entry_type: 'income', deleted_at: null },
									error: null,
								}),
							}),
						}),
					}),
				};
			}
			return { delete: () => ({ eq: removeEq }) };
		});
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				operation: 'evidenceUnavailable.delete',
				expenseId: 2,
			}),
		}));

		expect(response.status).toBe(200);
		expect(removeEq).toHaveBeenCalledWith('entry_id', 2);
	});
});

describe('POST /api/admin/kpi/cost-profit（固定資産の取引連携）', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		authorizeMock.mockResolvedValue(ADMIN);
	});

	const assetPayload = {
		id: 0,
		name: '業務用PC',
		account: '工具器具備品',
		// クライアントが送ってくる金額・取得日。連携時はこれを採用してはいけない。
		acquiredOn: '2020-01-01',
		acquisitionCost: 1,
		usefulLife: 6,
		method: 'straightLine',
		businessUseRatio: 100,
		disposedOn: null,
		serviceStartedOn: null,
		entryId: 7,
		memo: '',
	};

	function upsertMock(options: {
		entry?: Record<string, unknown> | null;
		existingAsset?: { id: number; name: string } | null;
	}) {
		const single = jest.fn().mockResolvedValue({ data: { id: 99 }, error: null });
		const insert = jest.fn().mockReturnValue({ select: () => ({ single }) });
		const assetSelect = jest.fn().mockReturnValue({
			eq: () => ({
				maybeSingle: () => Promise.resolve({ data: options.existingAsset ?? null, error: null }),
			}),
		});
		const entrySelect = jest.fn().mockReturnValue({
			eq: () => ({
				is: () => ({ maybeSingle: () => Promise.resolve({ data: options.entry ?? null, error: null }) }),
			}),
		});
		const from = jest.fn((table: string) =>
			table === 'admin_finance_expenses' ? { select: entrySelect } : { select: assetSelect, insert },
		);
		return { from, insert };
	}

	function postAsset(asset: Record<string, unknown>) {
		return POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ operation: 'fixedAsset.upsert', asset }),
		}));
	}

	it('連携時はクライアントの取得価額・取得日を無視して取引の値で保存する', async () => {
		const { from, insert } = upsertMock({
			entry: { id: 7, expense_date: '2026-08-01', amount: 300000, entry_type: 'expense', category: '工具器具備品' },
		});
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await postAsset(assetPayload);

		expect(response.status).toBe(200);
		expect(insert).toHaveBeenCalledWith(
			expect.objectContaining({
				acquired_on: '2026-08-01',
				acquisition_cost: 300000,
				entry_id: 7,
				service_started_on: null,
			}),
		);
	});

	it('連携先の取引が存在しなければ400', async () => {
		const { from } = upsertMock({ entry: null });
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await postAsset(assetPayload);
		expect(response.status).toBe(400);
		expect((await response.json()).error).toContain('連携先の取引が見つかりません');
	});

	it('取引の勘定科目が固定資産でなければ400', async () => {
		// 消耗品費のままだと取得仕訳が費用として立ち、台帳と元帳が食い違う。
		const { from } = upsertMock({
			entry: { id: 7, expense_date: '2026-08-01', amount: 300000, entry_type: 'expense', category: '消耗品費' },
		});
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await postAsset(assetPayload);
		expect(response.status).toBe(400);
		expect((await response.json()).error).toContain('消耗品費');
	});

	it('収入の取引には連携できない', async () => {
		const { from } = upsertMock({
			entry: { id: 7, expense_date: '2026-08-01', amount: 300000, entry_type: 'income', category: '工具器具備品' },
		});
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await postAsset(assetPayload);
		expect(response.status).toBe(400);
	});

	it('既に別の固定資産が連携している取引は409で弾く（二重計上の防止）', async () => {
		const { from } = upsertMock({
			entry: { id: 7, expense_date: '2026-08-01', amount: 300000, entry_type: 'expense', category: '工具器具備品' },
			existingAsset: { id: 42, name: '業務用PC' },
		});
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await postAsset(assetPayload);
		expect(response.status).toBe(409);
		expect((await response.json()).error).toContain('既に固定資産');
	});

	it('使用開始日が取得日より前なら400', async () => {
		const { from } = upsertMock({
			entry: { id: 7, expense_date: '2026-08-01', amount: 300000, entry_type: 'expense', category: '工具器具備品' },
		});
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await postAsset({ ...assetPayload, serviceStartedOn: '2026-07-01' });
		expect(response.status).toBe(400);
	});

	it('取引を指定しない直接登録は400で拒否する', async () => {
		const response = await postAsset({
			...assetPayload,
			entryId: null,
		});
		expect(response.status).toBe(400);
	});

	function expenseUpdateMock(linkedAsset: Record<string, unknown> | null) {
		const assetUpdateEq = jest.fn().mockResolvedValue({ error: null });
		const assetUpdate = jest.fn().mockReturnValue({ eq: assetUpdateEq });
		const assetSelect = jest.fn().mockReturnValue({
			eq: () => ({ maybeSingle: () => Promise.resolve({ data: linkedAsset, error: null }) }),
		});
		const expenseUpdate = jest.fn().mockReturnValue({
			eq: () => ({ is: () => ({ select: () => Promise.resolve({ data: [{ id: 7 }], error: null }) }) }),
		});
		const currentExpenseSelect = jest.fn().mockReturnValue({
			eq: () => ({ is: () => ({ maybeSingle: () => Promise.resolve({
				data: { amount: 350000, season_key: null, entry_type: 'expense' }, error: null,
			}) }) }),
		});
		const allocationSelect = jest.fn().mockReturnValue({
			eq: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }),
		});
		const from = jest.fn((table: string) => {
			if (table === 'admin_finance_expenses') return { select: currentExpenseSelect, update: expenseUpdate };
			if (table === 'admin_expense_cost_allocations') return { select: allocationSelect };
			return { select: assetSelect, update: assetUpdate };
		});
		return { from, assetUpdate, assetUpdateEq, expenseUpdate };
	}

	function postExpenseUpdate(overrides: Record<string, unknown> = {}) {
		return POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				operation: 'expense.update',
				fiscalYear: 2026,
				expenseId: 7,
				expense: {
					entryType: 'expense',
					date: '2026-08-01',
					category: '工具器具備品',
					item: '業務用PC',
					partner: '株式会社A',
					amount: 350000,
					paymentMethod: '銀行',
					memo: '',
					...overrides,
				},
			}),
		}));
	}

	it('取引の訂正に連携済みの固定資産を追随させる', async () => {
		const { from, assetUpdate, assetUpdateEq } = expenseUpdateMock({
			id: 42,
			name: '業務用PC',
			service_started_on: null,
			disposed_on: null,
		});
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await postExpenseUpdate();

		expect(response.status).toBe(200);
		expect(assetUpdate).toHaveBeenCalledWith({ acquisition_cost: 350000, acquired_on: '2026-08-01' });
		expect(assetUpdateEq).toHaveBeenCalledWith('id', 42);
	});

	it('連携資産が無ければ台帳は触らない', async () => {
		const { from, assetUpdate } = expenseUpdateMock(null);
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await postExpenseUpdate();

		expect(response.status).toBe(200);
		expect(assetUpdate).not.toHaveBeenCalled();
	});

	it('取引日を後ろへ動かして使用開始日が取得日より前になる訂正は409で差し戻す', async () => {
		// 取引を書き換える前に弾き、取引だけ更新された中途半端な状態を作らない。
		const { from, assetUpdate, expenseUpdate } = expenseUpdateMock({
			id: 42,
			name: '業務用PC',
			service_started_on: '2026-06-01',
			disposed_on: null,
		});
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await postExpenseUpdate({ date: '2026-09-01' });

		expect(response.status).toBe(409);
		expect((await response.json()).error).toContain('業務用PC');
		expect(expenseUpdate).not.toHaveBeenCalled();
		expect(assetUpdate).not.toHaveBeenCalled();
	});

	it('固定資産候補の除外は取引内容を変えずフラグだけ立てる', async () => {
		// updated_by を触らないので訂正履歴にも「訂正あり」としては残らない。
		const select = jest.fn().mockResolvedValue({ data: [{ id: 7 }], error: null });
		const isNull = jest.fn().mockReturnValue({ select });
		const eq = jest.fn().mockReturnValue({ is: isNull });
		const update = jest.fn().mockReturnValue({ eq });
		const from = jest.fn().mockReturnValue({ update });
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ operation: 'entry.assetExempt', expenseId: 7, exempt: true, reason: '修繕費として処理するため' }),
		}));

		expect(response.status).toBe(200);
		expect(from).toHaveBeenCalledWith('admin_finance_expenses');
		expect(update).toHaveBeenCalledWith(expect.objectContaining({
			fixed_asset_exempt: true,
			fixed_asset_exempt_reason: '修繕費として処理するため',
			fixed_asset_reviewed_by: 'admin-id',
		}));
		expect(eq).toHaveBeenCalledWith('id', 7);
		expect(isNull).toHaveBeenCalledWith('deleted_at', null);
	});
});
