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
function result(data: unknown) {
	return Promise.resolve({ data, error: null });
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
				const rows = [
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
						lte: () => ({ is: () => result(rows) }),
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
									amount: 80000,
									payment_method: '銀行',
									memo: '事務所',
								},
							]),
					}),
				};
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
		expect(body.data.incomes).toHaveLength(1);
		expect(body.data.incomes[0].item).toBe('オンライン販売');
		expect(body.data.incomes[0].entryType).toBe('income');
		expect(body.data.partners).toEqual(['丸善テキスタイル']);
		expect(body.data.templates).toEqual([
			{ name: '毎月の家賃', entryType: 'expense', category: '地代家賃', item: '打合せ・交通', amount: 80000, paymentMethod: '銀行', memo: '事務所' },
		]);
		expect(authorizeMock).toHaveBeenCalledWith('admin.finance.read', expect.any(Request));
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

	it('シーズンを指定すると商品原価を返す', async () => {
		const response = await GET(new Request('http://localhost/api/admin/kpi/cost-profit?year=2026&season=2026SS'));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.data.products[0].costs.material).toBe(3200);
	});

	it('不正なシーズンキーを拒否する', async () => {
		const response = await GET(new Request('http://localhost/api/admin/kpi/cost-profit?year=2026&season=invalid'));
		expect(response.status).toBe(400);
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
		const from = jest.fn().mockReturnValue({ update });

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
		const from = jest.fn().mockReturnValue({
			update: () => ({ eq: () => ({ eq: () => ({ is: () => ({ select }) }) }) }),
		});
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

	it('経費テンプレートを同名上書きでupsertする', async () => {
		const upsert = jest.fn().mockResolvedValue({ error: null });
		const from = jest.fn().mockReturnValue({ upsert });
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				operation: 'template.create',
				template: { name: '毎月の家賃', entryType: 'expense', category: '地代家賃', item: '打合せ・交通', amount: 80000, paymentMethod: '銀行', memo: '事務所' },
			}),
		}));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(from).toHaveBeenCalledWith('admin_finance_expense_templates');
		expect(upsert).toHaveBeenCalledWith(
			{
				name: '毎月の家賃',
				entry_type: 'expense',
				category: '地代家賃',
				item_name: '打合せ・交通',
				amount: 80000,
				payment_method: '銀行',
				memo: '事務所',
				created_by: 'admin-id',
			},
			{ onConflict: 'name' },
		);
	});
});
