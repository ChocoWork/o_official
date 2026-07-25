jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));
jest.mock('next/server', () => ({
	NextResponse: {
		json: (body: unknown, init?: { status?: number }) => ({
			status: init?.status ?? 200,
			json: async () => body,
		}),
	},
}));

import { GET } from '@/app/api/admin/kpi/cost-profit/route';
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
									data: [{
										id: 1,
										expense_date: '2026-05-24',
										category: '販売費・マーケティング',
										item_name: 'Instagram広告費',
										amount: 32000,
										payment_method: 'クレジットカード',
										memo: '広告',
									}],
									error: null,
								}),
							}),
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
		expect(body.data.expenses[0].item).toBe('Instagram広告費');
		expect(body.data.products[0].costs.material).toBe(3200);
		expect(authorizeMock).toHaveBeenCalledWith('admin.finance.read', expect.any(Request));
	});

	it('不正なシーズンキーを拒否する', async () => {
		const response = await GET(new Request('http://localhost/api/admin/kpi/cost-profit?season=invalid'));
		expect(response.status).toBe(400);
	});
});
