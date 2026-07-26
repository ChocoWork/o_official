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

function createFinanceSupabaseMock() {
	return {
		from: jest.fn((table: string) => {
			if (table === 'admin_finance_seasons') {
				return {
					select: jest.fn().mockReturnValue({
						eq: jest.fn().mockReturnValue({
							maybeSingle: jest.fn().mockResolvedValue({
								data: {
									season_key: '2026SS',
									sales_revenue: 3240000,
									opening_cash: 420000,
									accounts_receivable: 324000,
									fixed_assets: 260000,
									accounts_payable: 430000,
									opening_capital: 1091000,
								},
								error: null,
							}),
						}),
					}),
				};
			}

			if (table === 'admin_finance_expenses') {
				return {
					select: jest.fn().mockReturnValue({
						eq: jest.fn().mockReturnValue({
							order: jest.fn().mockReturnValue({
								order: jest.fn().mockResolvedValue({
									data: [
										{
											id: 1,
											entry_type: 'expense',
											expense_date: '2026-05-24',
											category: '販売費・マーケティング',
											item_name: 'Instagram広告費',
											partner: '丸善テキスタイル',
											amount: 32000,
											payment_method: 'クレジットカード',
											memo: '広告',
										},
										{
											id: 2,
											entry_type: 'income',
											expense_date: '2026-05-25',
											category: '売上高',
											item_name: 'オンライン販売',
											partner: '',
											amount: 120000,
											payment_method: '銀行振込',
											memo: '',
										},
									],
									error: null,
								}),
							}),
						}),
					}),
				};
			}

			if (table === 'admin_finance_partners') {
				return {
					select: jest.fn().mockReturnValue({
						order: jest.fn().mockResolvedValue({
							data: [{ id: 1, name: '丸善テキスタイル' }],
							error: null,
						}),
					}),
				};
			}

			if (table === 'admin_finance_expense_templates') {
				return {
					select: jest.fn().mockReturnValue({
						order: jest.fn().mockResolvedValue({
							data: [{
								name: '毎月の家賃',
								entry_type: 'expense',
								category: '地代家賃',
								item_name: '打合せ・交通',
								amount: 80000,
								payment_method: '銀行振込',
								memo: '事務所',
							}],
							error: null,
						}),
					}),
				};
			}

			return {
				select: jest.fn().mockReturnValue({
					eq: jest.fn().mockReturnValue({
						order: jest.fn().mockResolvedValue({
							data: [{
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
							}],
							error: null,
						}),
					}),
				}),
			};
		}),
	};
}

describe('GET /api/admin/kpi/cost-profit', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		authorizeMock.mockResolvedValue({ ok: true, userId: 'admin-id', role: 'admin', actorEmail: 'admin@example.com' });
		createServiceMock.mockResolvedValue(createFinanceSupabaseMock() as never);
	});

	it('管理者へシーズンの会計データを返す', async () => {
		const response = await GET(new Request('http://localhost/api/admin/kpi/cost-profit?season=2026SS'));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.data.plan.salesRevenue).toBe(3240000);
		// entry_type で支出・収入に振り分けられる。
		expect(body.data.expenses).toHaveLength(1);
		expect(body.data.expenses[0].item).toBe('Instagram広告費');
		expect(body.data.expenses[0].partner).toBe('丸善テキスタイル');
		expect(body.data.incomes).toHaveLength(1);
		expect(body.data.incomes[0].item).toBe('オンライン販売');
		expect(body.data.incomes[0].entryType).toBe('income');
		expect(body.data.products[0].costs.material).toBe(3200);
		expect(body.data.partners).toEqual(['丸善テキスタイル']);
		expect(body.data.templates).toEqual([
			{ name: '毎月の家賃', entryType: 'expense', category: '地代家賃', item: '打合せ・交通', amount: 80000, paymentMethod: '銀行振込', memo: '事務所' },
		]);
		expect(authorizeMock).toHaveBeenCalledWith('admin.finance.read', expect.any(Request));
	});

	it('不正なシーズンキーを拒否する', async () => {
		const response = await GET(new Request('http://localhost/api/admin/kpi/cost-profit?season=invalid'));
		expect(response.status).toBe(400);
	});

	it('指定した経費行をシーズン条件付きで削除する', async () => {
		authorizeMock.mockResolvedValue({ ok: true, userId: 'admin-id', role: 'admin', actorEmail: 'admin@example.com' });

		const select = jest.fn().mockResolvedValue({ data: [{ id: 12 }], error: null });
		const secondEq = jest.fn().mockReturnValue({ select });
		const firstEq = jest.fn().mockReturnValue({ eq: secondEq });
		const deleteRow = jest.fn().mockReturnValue({ eq: firstEq });
		const from = jest.fn().mockReturnValue({ delete: deleteRow });

		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ operation: 'expense.delete', seasonKey: '2026SS', expenseId: 12 }),
		}));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(from).toHaveBeenCalledTimes(1);
		expect(from).toHaveBeenCalledWith('admin_finance_expenses');
		expect(firstEq).toHaveBeenCalledWith('id', 12);
		expect(secondEq).toHaveBeenCalledWith('season_key', '2026SS');
	});

	it('収入（entryType=income）を entry_type 付きで登録する', async () => {
		authorizeMock.mockResolvedValue({ ok: true, userId: 'admin-id', role: 'admin', actorEmail: 'admin@example.com' });

		const seasonUpsert = jest.fn().mockResolvedValue({ error: null });
		const single = jest.fn().mockResolvedValue({ data: { id: 5, entry_type: 'income' }, error: null });
		const select = jest.fn().mockReturnValue({ single });
		const insert = jest.fn().mockReturnValue({ select });
		const from = jest.fn((table: string) => (table === 'admin_finance_seasons' ? { upsert: seasonUpsert } : { insert }));
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				operation: 'expense.create',
				seasonKey: '2026SS',
				expense: { entryType: 'income', date: '2026-05-25', category: '売上高', item: 'オンライン販売', amount: 120000, paymentMethod: '銀行振込' },
			}),
		}));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(insert).toHaveBeenCalledWith(expect.objectContaining({ entry_type: 'income', item_name: 'オンライン販売', amount: 120000 }));
	});

	it('取引先マスタへ新規取引先をupsertする', async () => {
		authorizeMock.mockResolvedValue({ ok: true, userId: 'admin-id', role: 'admin', actorEmail: 'admin@example.com' });

		const upsert = jest.fn().mockResolvedValue({ error: null });
		const from = jest.fn().mockReturnValue({ upsert });
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ operation: 'partner.create', seasonKey: '2026SS', partnerName: '丸善テキスタイル' }),
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
		authorizeMock.mockResolvedValue({ ok: true, userId: 'admin-id', role: 'admin', actorEmail: 'admin@example.com' });

		const upsert = jest.fn().mockResolvedValue({ error: null });
		const from = jest.fn().mockReturnValue({ upsert });
		createServiceMock.mockResolvedValueOnce({ from } as never);

		const response = await POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				operation: 'template.create',
				seasonKey: '2026SS',
				template: { name: '毎月の家賃', category: '地代家賃', item: '打合せ・交通', amount: 80000, paymentMethod: '銀行振込', memo: '事務所' },
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
				payment_method: '銀行振込',
				memo: '事務所',
				created_by: 'admin-id',
			},
			{ onConflict: 'name' },
		);
	});
});
