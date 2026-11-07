jest.mock('server-only', () => ({}), { virtual: true });
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
import { authorizeAdminPermission, type PermissionCode } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';

const authorizeMock = authorizeAdminPermission as jest.MockedFunction<typeof authorizeAdminPermission>;
const createServiceMock = createServiceRoleClient as jest.MockedFunction<typeof createServiceRoleClient>;

const ADMIN = {
	ok: true as const,
	userId: 'admin-id',
	role: 'admin' as const,
	actorEmail: 'admin@example.com',
	permissions: new Set<PermissionCode>(),
};

// 会計は暦年（1/1〜12/31）で切る。シーズンは商品原価の絞り込みにのみ使う任意パラメータ。
// GET は 9 本のクエリを Promise.all で並べるため、テーブル名ごとに終端の thenable を返す。
let financeQueryError: { code: string; message: string } | null = null;
let cumulativeRowsOverride: Array<Record<string, unknown>> | null = null;
let cumulativeRangeCalls: Array<[number, number]> = [];
let cumulativePageLimit: number | null = null;
let expenseSelectColumns: string[] = [];

// 会計の期間・保存した仕訳・期首（会計 S3 の読み口）。既定は個人の2026年の期間1つ。
const periodUuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function periodRow(n: number, startsOn: string, endsOn: string, businessType = 'soleProprietor', name = `${startsOn.slice(0, 4)}年（個人）`) {
	return {
		id: periodUuid(n), business_type: businessType, name, starts_on: startsOn, ends_on: endsOn,
		corporate_tax_extension_months: 0, consumption_tax_extension_months: 0, consumption_tax_status: 'exempt',
		consumption_taxable_from: null, version: '1', legacy_fiscal_year: businessType === 'soleProprietor' ? Number(startsOn.slice(0, 4)) : null,
	};
}
const SETTINGS_ROW = {
	business_start_date: null, cutover_on: '2026-11-07', current_business_type: 'soleProprietor',
	sole_business_ended_on: null, version: '1', sole_end_changes: [],
};
let accountingPeriodRows: Array<Record<string, unknown>> = [periodRow(2026, '2026-01-01', '2026-12-31')];
let settingsRow: Record<string, unknown> = SETTINGS_ROW;
let journalPages: Array<{ data: unknown; error: unknown }> = [];
let openingRows: Array<Record<string, unknown>> = [];
let rangeCalls: Array<[string, string, string, unknown]> = [];

function savedEntryRow(n: number, periodN = 2026, amount = 1_000): Record<string, unknown> {
	return {
		id: periodUuid(100_000 + n), period_id: periodUuid(periodN), entry_no: n, entry_date: '2026-03-01', event_kind: 'manual_entry',
		dedupe_key: `manual_entry:${n}:0`, description: `手入力${n}`, recorded_at: '2026-03-01T01:00:00+00:00', recorded_by: null,
		is_late: false, reverses_entry_id: null, reason: null, source_table: 'admin_finance_expenses', source_id: String(n),
		migrated_from: null, migrated_at: null, source_recorded_at: null,
		lines: [
			{ line_no: 1, account_code: '6060', debit: amount, credit: 0, sub_account: null, counterparty: null, order_id: null, memo: null },
			{ line_no: 2, account_code: '1010', debit: 0, credit: amount, sub_account: null, counterparty: null, order_id: null, memo: null },
		],
	};
}

function accountingRpc(name: string, args?: Record<string, unknown>) {
	void args;
	if (name === 'list_accounting_periods') return Promise.resolve({ data: accountingPeriodRows, error: null });
	if (name === 'get_accounting_settings') return Promise.resolve({ data: settingsRow, error: null });
	if (name === 'get_accounting_opening') return Promise.resolve({ data: openingRows, error: null });
	if (name === 'list_accounting_journal') {
		return Promise.resolve(journalPages.shift() ?? { data: { entries: [], next_after_date: null, next_after_no: null }, error: null });
	}
	return Promise.resolve({ data: null, error: { code: '42883', message: `unknown rpc ${name}` } });
}

function rangeChain<T>(table: string, terminal: () => T) {
	return {
		gte: (column: string, from: unknown) => {
			rangeCalls.push([table, 'gte', column, from]);
			return {
				lt: (ltColumn: string, to: unknown) => {
					rangeCalls.push([table, 'lt', ltColumn, to]);
					return terminal();
				},
			};
		},
	};
}

let stripeBalanceTransactionRows: Array<Record<string, unknown>> = [];
let stripeRefundRows: Array<Record<string, unknown>> = [];
let stripePayoutRows: Array<Record<string, unknown>> = [];
let orderRowsOverride: Array<Record<string, unknown>> | null = null;

function result(data: unknown) {
	return Promise.resolve({ data, error: financeQueryError });
}

function createFinanceSupabaseMock() {
	return {
		rpc: jest.fn(accountingRpc),
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
					select: (columns?: string) => {
						expenseSelectColumns.push(columns ?? '');
						return {
						// 期間の取引一覧：取引の日を期間の端で絞り、論理削除を除外して並べ替える
						gte: (column: string, from: unknown) => {
							rangeCalls.push(['admin_finance_expenses', 'gte', column, from]);
							return {
								lte: (lteColumn: string, to: unknown) => {
									rangeCalls.push(['admin_finance_expenses', 'lte', lteColumn, to]);
									return {
										is: () => ({
											order: () => ({ order: () => result(rows) }),
										}),
									};
								},
							};
						},
						// 開業以来累計：期間の終わりの日までを取る
						lte: (column: string, to: unknown) => {
							rangeCalls.push(['admin_finance_expenses:cumulative', 'lte', column, to]);
							return {
							is: () => ({
								order: () => ({ order: () => ({ range: (from: number, to: number) => {
									cumulativeRangeCalls.push([from, to]);
									return Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + (cumulativePageLimit ?? Number.MAX_SAFE_INTEGER))), count: rows.length, error: financeQueryError });
								} }) }),
							}),
							};
						},
						};
					},
				};
			}

			if (table === 'orders') {
				return {
					select: () => rangeChain('orders', () => ({
								order: () => ({
									order: () => result(orderRowsOverride ?? [
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
							})),
				};
			}

			if (table === 'stripe_balance_transactions') {
				return { select: () => rangeChain(table, () => ({ order: () => result(stripeBalanceTransactionRows) })) };
			}

			if (table === 'stripe_refunds') {
				return { select: () => rangeChain(table, () => ({ order: () => result(stripeRefundRows) })) };
			}

			if (table === 'stripe_payouts') {
				return { select: () => rangeChain(table, () => ({ order: () => result(stripePayoutRows) })) };
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
		expenseSelectColumns = [];
		stripeBalanceTransactionRows = [];
		stripeRefundRows = [];
		stripePayoutRows = [];
		orderRowsOverride = null;
		rangeCalls = [];
		journalPages = [];
		openingRows = [];
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

	it('Stripe原始記録と精算サマリーを返す', async () => {
		stripeBalanceTransactionRows = [
			{
				id: 'txn_1', source_id: 'ch_1', payment_intent_id: 'pi_1', order_id: 'order-1',
				payout_id: null, type: 'charge', reporting_category: 'charge',
				amount: 10_000, fee: 360, net: 9_640, currency: 'jpy', status: 'available',
				available_on: '2026-05-28', stripe_created_at: '2026-05-26T01:00:00.000Z',
			},
		];

		const body = await (await GET(new Request('http://localhost/api/admin/kpi/cost-profit?year=2026'))).json();

		expect(body.data.stripeAccounting).toMatchObject({
			balanceTransactions: expect.any(Array),
			refunds: expect.any(Array),
			payouts: expect.any(Array),
			summary: {
				stripeBalance: 9_640,
				inTransitBalance: 0,
				unmatchedPayoutCount: 0,
			},
		});
		expect(body.data.stripeAccounting.balanceTransactions).toHaveLength(1);
	});

	it('Stripe投影済みの注文は総額売上を保つ', async () => {
		stripeBalanceTransactionRows = [
			{
				id: 'txn_1', source_id: 'ch_1', payment_intent_id: 'pi_1', order_id: 'order-1',
				payout_id: null, type: 'charge', reporting_category: 'charge',
				amount: 25_300, fee: 900, net: 24_400, currency: 'jpy', status: 'available',
				available_on: '2026-05-28', stripe_created_at: '2026-05-26T01:00:00.000Z',
			},
		];

		const body = await (await GET(new Request('http://localhost/api/admin/kpi/cost-profit?year=2026'))).json();

		expect(body.data.incomes[1]).toEqual(expect.objectContaining({
			sourceId: 'order-1',
			amount: 25_300,
			grossAmount: 25_300,
			refundedAmount: 0,
		}));
	});

	it('入金途上と未照合Payoutを集計する', async () => {
		stripeBalanceTransactionRows = [
			{
				id: 'txn_1', source_id: 'ch_1', payment_intent_id: 'pi_1', order_id: 'order-1',
				payout_id: null, type: 'charge', reporting_category: 'charge',
				amount: 10_000, fee: 360, net: 9_640, currency: 'jpy', status: 'available',
				stripe_created_at: '2026-05-26T01:00:00.000Z',
			},
			{
				id: 'txn_payout', source_id: 'po_1', payment_intent_id: null, order_id: null,
				payout_id: 'po_1', type: 'payout', reporting_category: 'payout',
				amount: -9_640, fee: 0, net: -9_640, currency: 'jpy', status: 'available',
				stripe_created_at: '2026-05-30T01:00:00.000Z',
			},
		];
		stripePayoutRows = [
			{
				id: 'po_1', amount: 9_640, currency: 'jpy', status: 'paid', automatic: true,
				arrival_date: '2026-06-01', stripe_created_at: '2026-05-30T01:00:00.000Z',
				paid_at: '2026-05-30T01:00:00.000Z', reconciliation_status: 'matched',
				reconciled_net: 9_640, bank_confirmed_at: null, bank_arrival_date: null,
			},
			{
				id: 'po_2', amount: 5_000, currency: 'jpy', status: 'paid', automatic: true,
				arrival_date: '2026-06-10', stripe_created_at: '2026-06-08T01:00:00.000Z',
				paid_at: '2026-06-08T01:00:00.000Z', reconciliation_status: 'mismatch',
				reconciled_net: 4_000, bank_confirmed_at: null, bank_arrival_date: null,
			},
		];

		const body = await (await GET(new Request('http://localhost/api/admin/kpi/cost-profit?year=2026'))).json();

		expect(body.data.stripeAccounting.summary).toEqual({
			stripeBalance: 0,
			inTransitBalance: 9_640,
			unmatchedPayoutCount: 1,
		});
	});

	it('Stripe精算テーブルが未作成でも会計データを返す', async () => {
		createServiceMock.mockResolvedValue({
			...createFinanceSupabaseMock(),
			from: jest.fn((table: string) => {
				if (table.startsWith('stripe_')) {
					return {
						select: () => ({ gte: () => ({ lt: () => ({ order: () => Promise.resolve({
							data: null,
							error: { code: '42P01', message: `relation "${table}" does not exist` },
						}) }) }) }),
					};
				}
				return createFinanceSupabaseMock().from(table);
			}),
		} as never);

		const response = await GET(new Request('http://localhost/api/admin/kpi/cost-profit?year=2026'));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.data.expenses).toHaveLength(1);
		expect(body.data.stripeAccounting).toEqual({
			balanceTransactions: [],
			refunds: [],
			payouts: [],
			summary: { stripeBalance: 0, inTransitBalance: 0, unmatchedPayoutCount: 0 },
		});
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

describe('GET /api/admin/kpi/cost-profit（期間で数える）', () => {
	let client: ReturnType<typeof createFinanceSupabaseMock>;
	const get = async (query: string) => {
		const response = await GET(new Request(`http://localhost/api/admin/kpi/cost-profit?${query}`));
		return { status: response.status, body: await response.json() };
	};
	const journalCalls = () => client.rpc.mock.calls.filter(([name]) => name === 'list_accounting_journal');

	beforeEach(() => {
		jest.clearAllMocks();
		// 今日は 2026-11-07（日本時間）。Date だけを止め、Promise の進みは止めない。
		jest.useFakeTimers({
			now: new Date('2026-11-07T03:00:00.000Z'),
			doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'clearImmediate'],
		});
		financeQueryError = null;
		cumulativeRowsOverride = null;
		cumulativeRangeCalls = [];
		cumulativePageLimit = null;
		expenseSelectColumns = [];
		stripeBalanceTransactionRows = [];
		stripeRefundRows = [];
		stripePayoutRows = [];
		orderRowsOverride = null;
		rangeCalls = [];
		journalPages = [];
		openingRows = [];
		settingsRow = SETTINGS_ROW;
		accountingPeriodRows = [
			periodRow(2025, '2025-01-01', '2025-12-31'),
			periodRow(2026, '2026-01-01', '2026-12-31'),
			periodRow(2027, '2027-07-15', '2028-07-14', 'corporation', '第1期'),
		];
		authorizeMock.mockResolvedValue(ADMIN);
		client = createFinanceSupabaseMock();
		createServiceMock.mockResolvedValue(client as never);
	});
	afterEach(() => {
		jest.useRealTimers();
		accountingPeriodRows = [periodRow(2026, '2026-01-01', '2026-12-31')];
		orderRowsOverride = null;
		journalPages = [];
		openingRows = [];
	});

	it('FREQ-557-AC-01: 旧の year クエリは個人の暦年の期間に結ばれる', async () => {
		const { status, body } = await get('year=2025');

		expect(status).toBe(200);
		expect(body.data.period).toEqual(expect.objectContaining({
			id: periodUuid(2025), businessType: 'soleProprietor', startsOn: '2025-01-01', endsOn: '2025-12-31',
		}));
		expect(body.data.fiscalYear).toBe(2025);
		expect(body.data.periods.map((period: { id: string }) => period.id)).toEqual([2025, 2026, 2027].map(periodUuid));
		// 範囲は期間の端（日付）と、日本時間の0時を UTC にした時刻で絞る。
		expect(rangeCalls).toEqual(expect.arrayContaining([
			['admin_finance_expenses', 'gte', 'expense_date', '2025-01-01'],
			['admin_finance_expenses', 'lte', 'expense_date', '2025-12-31'],
			['admin_finance_expenses:cumulative', 'lte', 'expense_date', '2025-12-31'],
			['orders', 'gte', 'created_at', '2024-12-31T15:00:00.000Z'],
			['orders', 'lt', 'created_at', '2025-12-31T15:00:00.000Z'],
			['stripe_balance_transactions', 'gte', 'stripe_created_at', '2024-12-31T15:00:00.000Z'],
			['stripe_payouts', 'lt', 'stripe_created_at', '2025-12-31T15:00:00.000Z'],
		]));
		expect(journalCalls()[0][1]).toEqual(expect.objectContaining({ _period_id: periodUuid(2025), _limit: 200 }));
		expect(client.rpc).toHaveBeenCalledWith('get_accounting_opening', { _period_id: periodUuid(2025) });

		// periodId も year も無ければ従来どおり 400。
		expect((await get('')).status).toBe(400);
	});

	it('FREQ-557-AC-01: 期間を選ぶと選んだ期間の保存した仕訳と期首だけを数える', async () => {
		openingRows = [
			{ account_code: '1040', signed_amount: 5_000, basis: 'carryover' },
			{ account_code: '3010', signed_amount: -5_000, basis: 'carryover' },
		];
		journalPages = [{ data: { entries: [savedEntryRow(1, 2027)], next_after_date: null, next_after_no: null }, error: null }];

		const { status, body } = await get(`periodId=${periodUuid(2027)}`);

		expect(status).toBe(200);
		expect(body.data.period).toEqual(expect.objectContaining({ id: periodUuid(2027), businessType: 'corporation', name: '第1期' }));
		expect(body.data.businessType).toBe('corporation');
		expect(body.data.savedJournal.map((entry: { dedupeKey: string }) => entry.dedupeKey)).toEqual(['manual_entry:1:0']);
		expect(body.data.opening).toEqual([
			{ accountCode: '1040', signedAmount: 5_000, basis: 'carryover' },
			{ accountCode: '3010', signedAmount: -5_000, basis: 'carryover' },
		]);
		expect(journalCalls().map(([, args]) => (args as { _period_id: string })._period_id)).toEqual([periodUuid(2027)]);
		expect(client.rpc).toHaveBeenCalledWith('get_accounting_opening', { _period_id: periodUuid(2027) });
		expect(rangeCalls).toEqual(expect.arrayContaining([
			['admin_finance_expenses', 'gte', 'expense_date', '2027-07-15'],
			['admin_finance_expenses', 'lte', 'expense_date', '2028-07-14'],
			['orders', 'gte', 'created_at', '2027-07-14T15:00:00.000Z'],
			['orders', 'lt', 'created_at', '2028-07-14T15:00:00.000Z'],
		]));

		// 形の違う periodId は 400、無い期間は 404（本文は読み切れる JSON）。
		expect((await get('periodId=not-a-uuid')).status).toBe(400);
		const missing = await get(`periodId=${periodUuid(1999)}`);
		expect(missing.status).toBe(404);
		expect(missing.body).toEqual({ error: '会計の記録が見つかりません。', code: 'ACCOUNTING_NOT_FOUND' });
	});

	it('FREQ-557-AC-01: 12月28日に払った注文は注文を作った日の期間に出て年を作り直しても二重に数えない', async () => {
		orderRowsOverride = [
			{ id: 'order-1228', payment_intent_id: 'pi_a', status: 'paid', total_amount: 10_000, refunded_amount: 0, currency: 'jpy', created_at: '2026-12-28T05:00:00.000Z' },
			// 日本時間では 2027-01-01 00:30。2026年の期間には入れない。
			{ id: 'order-newyear', payment_intent_id: 'pi_b', status: 'paid', total_amount: 7_000, refunded_amount: 0, currency: 'jpy', created_at: '2026-12-31T15:30:00.000Z' },
		];

		const first = await get('year=2026');
		const again = await get('year=2026');

		for (const { status, body } of [first, again]) {
			expect(status).toBe(200);
			const orders = body.data.incomes.filter((income: { source?: string }) => income.source === 'order');
			expect(orders.map((income: { sourceId: string; date: string }) => [income.sourceId, income.date])).toEqual([['order-1228', '2026-12-28']]);
		}
	});

	it('FREQ-557-AC-05: 期間が1つも無いときは404でなく空の画面を返し作成を案内する', async () => {
		accountingPeriodRows = [];

		const { status, body } = await get('year=2026');

		expect(status).toBe(200);
		expect(body.data).toEqual(expect.objectContaining({
			period: null,
			periods: [],
			savedJournal: [],
			opening: [],
			periodNotices: { filingDeadlinePassed: false, previousPeriodOpen: false },
			expenses: [],
			incomes: [],
		}));
		expect(journalCalls()).toHaveLength(0);
	});

	it('FREQ-557-AC-05: 前の期間を締めていない間は数字がまだ動くと出し、期限を過ぎた期間への入力に知らせる', async () => {
		openingRows = [{ account_code: '1040', signed_amount: 1_000, basis: 'carryover' }, { account_code: '2910', signed_amount: -1_000, basis: 'carryover' }];
		// 2026年: 前の2025年は締めていない（期首は繰越の計算）。申告の期限 2027-03-15 は先。
		expect((await get('year=2026')).body.data.periodNotices).toEqual({ filingDeadlinePassed: false, previousPeriodOpen: true });
		// 2025年: 前の期間は無い。申告の期限 2026-03-16 を過ぎている。
		expect((await get('year=2025')).body.data.periodNotices).toEqual({ filingDeadlinePassed: true, previousPeriodOpen: false });
		// 締めた版から取った期首（stored）なら数字はもう動かない。
		openingRows = [{ account_code: '1040', signed_amount: 1_000, basis: 'stored' }, { account_code: '2910', signed_amount: -1_000, basis: 'stored' }];
		expect((await get('year=2026')).body.data.periodNotices).toEqual({ filingDeadlinePassed: false, previousPeriodOpen: false });
		// 法人の第1期は、前に個人の期間があっても期首を写さないので「まだ動く」を出さない。
		openingRows = [];
		expect((await get(`periodId=${periodUuid(2027)}`)).body.data.periodNotices).toEqual({ filingDeadlinePassed: false, previousPeriodOpen: false });
	});

	it('FREQ-557-AC-06: 保存した仕訳が201件ある期間は101件目と201件目も読み試算表と元帳と決算書の合計に入る', async () => {
		journalPages = [
			{ data: { entries: Array.from({ length: 200 }, (_, i) => savedEntryRow(i + 1)), next_after_date: '2026-03-01', next_after_no: 200 }, error: null },
			{ data: { entries: [savedEntryRow(201)], next_after_date: null, next_after_no: null }, error: null },
		];

		const { status, body } = await get('year=2026');

		expect(status).toBe(200);
		expect(body.data.savedJournal).toHaveLength(201);
		expect(body.data.savedJournal[100].entryNo).toBe(101);
		expect(body.data.savedJournal[200].entryNo).toBe(201);
		expect(journalCalls().map(([, args]) => args)).toEqual([
			expect.objectContaining({ _limit: 200, _after_entry_date: null, _after_entry_no: null }),
			expect.objectContaining({ _limit: 200, _after_entry_date: '2026-03-01', _after_entry_no: 200 }),
		]);
	});

	it('FREQ-557-AC-06: ページの上限または途中の取得失敗では一部しか読めていないと出し合計も書き出しも出さない', async () => {
		// 100ページ目にも続きがある → 500 JOURNAL_TOO_LARGE。欠けた配列は返さない。
		journalPages = Array.from({ length: 100 }, (_, i) => ({
			data: { entries: [savedEntryRow(i + 1)], next_after_date: '2026-03-01', next_after_no: i + 1 },
			error: null,
		}));
		const tooLarge = await get('year=2026');
		expect(tooLarge.status).toBe(500);
		expect(tooLarge.body).toEqual({ error: '会計データの取得に失敗しました。', code: 'JOURNAL_TOO_LARGE' });
		expect(journalCalls()).toHaveLength(100);

		// 2ページ目の取得が失敗 → 500 JOURNAL_INCOMPLETE。
		journalPages = [
			{ data: { entries: [savedEntryRow(1)], next_after_date: '2026-03-01', next_after_no: 1 }, error: null },
			{ data: null, error: { code: 'XX000', message: 'boom' } },
		];
		const incomplete = await get('year=2026');
		expect(incomplete.status).toBe(500);
		expect(incomplete.body).toEqual({ error: '会計データの取得に失敗しました。', code: 'JOURNAL_INCOMPLETE' });
		expect(JSON.stringify(incomplete.body)).not.toContain('boom');
	});
});

describe('GET /api/admin/kpi/cost-profit（証憑の種類）', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		financeQueryError = null;
		cumulativeRangeCalls = [];
		cumulativePageLimit = null;
		expenseSelectColumns = [];
		authorizeMock.mockResolvedValue(ADMIN);
		createServiceMock.mockResolvedValue(createFinanceSupabaseMock() as never);
	});
	afterEach(() => {
		cumulativeRowsOverride = null;
	});

	it('FREQ-559-AC-02: 会計のGETは証憑の種類と紙の原本の有無を返す', async () => {
		const receipt = (id: number, kind: string, kept: boolean | null) => ({
			id, storage_path: `2026/1/${id}.pdf`, file_name: `${id}.pdf`, mime_type: 'application/pdf', file_size: 10,
			created_at: '2026-05-24T01:00:00.000Z', evidence_kind: kind, paper_original_kept: kept,
		});
		cumulativeRowsOverride = [{
			id: 1, entry_type: 'expense', expense_date: '2026-05-24', category: '広告宣伝費', item_name: 'Instagram広告費',
			partner: '', amount: 32000, payment_method: 'クレジットカード', memo: '', season_key: null,
			admin_finance_receipts: [receipt(7, 'electronic', null), receipt(8, 'paper', true), receipt(9, 'unconfirmed', null)],
		}];

		const response = await GET(new Request('http://localhost/api/admin/kpi/cost-profit?year=2026'));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.data.expenses[0].receipts.map((r: Record<string, unknown>) => [r.id, r.evidenceKind, r.paperOriginalKept]))
			.toEqual([[7, 'electronic', null], [8, 'paper', true], [9, 'unconfirmed', null]]);
		// 当年度の一覧の射影が、埋め込みの証憑に種類の2列を持つ。
		const listing = expenseSelectColumns.find((columns) => columns.includes('admin_finance_receipts('));
		expect(listing).toMatch(/admin_finance_receipts\([^)]*evidence_kind[^)]*\)/);
		expect(listing).toMatch(/admin_finance_receipts\([^)]*paper_original_kept[^)]*\)/);
	});
});

describe('POST /api/admin/kpi/cost-profit（証憑の種類）', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		authorizeMock.mockResolvedValue(ADMIN);
	});

	function postAttach(receiptFields: Record<string, unknown>) {
		return POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				operation: 'receipt.attach',
				expenseId: 28,
				receipt: { storagePath: '2026/28/a.pdf', fileName: 'a.pdf', mimeType: 'application/pdf', fileSize: 10, ...receiptFields },
			}),
		}));
	}

	it('FREQ-559-AC-02: receipt.attachは種類を必須にし紙には原本の有無を必須にする', async () => {
		const single = jest.fn().mockResolvedValue({ data: { id: 3 }, error: null });
		const insert = jest.fn().mockReturnValue({ select: () => ({ single }) });
		createServiceMock.mockResolvedValue({ from: jest.fn(() => ({ insert })) } as never);

		expect((await postAttach({ evidenceKind: 'electronic' })).status).toBe(200);
		expect(insert).toHaveBeenLastCalledWith(expect.objectContaining({ evidence_kind: 'electronic', paper_original_kept: null }));
		expect((await postAttach({ evidenceKind: 'paper', paperOriginalKept: true })).status).toBe(200);
		expect(insert).toHaveBeenLastCalledWith(expect.objectContaining({ evidence_kind: 'paper', paper_original_kept: true }));
		expect((await postAttach({ evidenceKind: 'paper', paperOriginalKept: false })).status).toBe(200);
		expect(insert).toHaveBeenLastCalledWith(expect.objectContaining({ evidence_kind: 'paper', paper_original_kept: false }));

		// 種類は必須。送らない要求は断り、DB の既定の「未確認」を新しく作らない。
		const insertCount = insert.mock.calls.length;
		for (const fields of [
			{},
			{ evidenceKind: 'paper' },
			{ evidenceKind: 'paper', paperOriginalKept: 'true' },
			{ evidenceKind: 'electronic', paperOriginalKept: false },
			{ paperOriginalKept: true },
			{ evidenceKind: 'unconfirmed' },
			{ evidenceKind: 'scan' },
		]) {
			const response = await postAttach(fields);
			expect({ fields, status: response.status }).toEqual({ fields, status: 400 });
		}
		expect(insert).toHaveBeenCalledTimes(insertCount);
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

	// 会計 S4: 手入力の取引はトリガーが仕訳にし、期間が無いと取引の行ごと ACCOUNTING_PERIOD_MISSING で断られる。
	function periodMissingInsert(details: string | null) {
		const yearUpsert = jest.fn().mockResolvedValue({ error: null });
		const single = jest.fn().mockResolvedValue({
			data: null,
			error: { code: '55000', message: 'ACCOUNTING_PERIOD_MISSING', details, hint: null },
		});
		const insert = jest.fn().mockReturnValue({ select: () => ({ single }) });
		const from = jest.fn((table: string) => (table === 'admin_finance_years' ? { upsert: yearUpsert } : { insert }));
		createServiceMock.mockResolvedValueOnce({ from } as never);
		return { insert };
	}
	const createRequest = () => new Request('http://localhost/api/admin/kpi/cost-profit', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			operation: 'expense.create',
			fiscalYear: 2027,
			expense: { entryType: 'expense', date: '2027-08-01', category: '消耗品費', item: 'ペン', amount: 1200, paymentMethod: '現金' },
		}),
	});

	it('FREQ-556-AC-02: 経費の作成は期間が無いとき409と日本語の本文を返す', async () => {
		const { insert } = periodMissingInsert(null);
		const response = await POST(createRequest());

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: 'この日付の会計の期間がありません。先に期間を作ってください。',
			code: 'ACCOUNTING_PERIOD_MISSING',
		});
		// 書き込みの形は変えない（service_role から表へ直接 insert する）。
		expect(insert).toHaveBeenCalledWith(expect.objectContaining({ expense_date: '2027-08-01', item_name: 'ペン', created_by: 'admin-id' }));
	});

	it('FREQ-555-AC-09: やめた日より後の手入力は、法人へ未切り替えなら日を確かめてから切り替える案内で断られる', async () => {
		periodMissingInsert('sole_ended_not_switched');
		const response = await POST(createRequest());
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body).toEqual({
			error: 'やめた日より後の日付です。やめた日が正しいか確かめ、正しければ事業の形を法人へ切り替えてください。',
			code: 'ACCOUNTING_PERIOD_MISSING',
		});
		expect(JSON.stringify(body)).not.toContain('sole_ended_not_switched');
	});

	it('FREQ-556-AC-02: 年の範囲の外の日付はARGUMENT_INVALIDの400と日本語の本文で断り、500になる拒否は従来どおり500', async () => {
		const failWith = (error: Record<string, unknown>) => {
			const single = jest.fn().mockResolvedValue({ data: null, error });
			const from = jest.fn((table: string) => (table === 'admin_finance_years'
				? { upsert: jest.fn().mockResolvedValue({ error: null }) }
				: { insert: () => ({ select: () => ({ single }) }) }));
			createServiceMock.mockResolvedValueOnce({ from } as never);
		};
		failWith({ code: '22023', message: 'ACCOUNTING_ARGUMENT_INVALID', details: null, hint: null });
		const invalid = await POST(createRequest());
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toEqual({ error: '入力を確かめてください。', code: 'ACCOUNTING_ARGUMENT_INVALID' });

		failWith({ code: '55000', message: 'ACCOUNTING_HISTORY_IMMUTABLE', details: null, hint: null });
		const immutable = await POST(createRequest());
		expect(immutable.status).toBe(500);
		expect(await immutable.json()).toEqual({ error: '会計データの保存に失敗しました。' });
	});

	it('FREQ-556-AC-02: 取引の直しと削除も期間が無いときは409と日本語の本文を返し、ほかのDBの失敗は500のまま', async () => {
		const periodMissing = { code: '55000', message: 'ACCOUNTING_PERIOD_MISSING', details: null };
		const deleteFrom = (error: unknown) => jest.fn((table: string) => table === 'admin_expense_cost_allocations'
			? { select: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }) }
			: { update: () => ({ eq: () => ({ eq: () => ({ is: () => ({ select: () => Promise.resolve({ data: null, error }) }) }) }) }) });
		const deleteRequest = () => new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ operation: 'expense.delete', fiscalYear: 2026, expenseId: 12 }),
		});
		createServiceMock.mockResolvedValueOnce({ from: deleteFrom(periodMissing) } as never);
		const deleted = await POST(deleteRequest());
		expect(deleted.status).toBe(409);
		expect((await deleted.json()).code).toBe('ACCOUNTING_PERIOD_MISSING');

		// 同じ文でも SQLSTATE が違えば固定の失敗とは見なさない。
		createServiceMock.mockResolvedValueOnce({ from: deleteFrom({ ...periodMissing, code: '23505' }) } as never);
		const other = await POST(deleteRequest());
		expect(other.status).toBe(500);

		const from = jest.fn((table: string) => {
			if (table === 'admin_finance_expenses') {
				return {
					select: () => ({ eq: () => ({ is: () => ({ maybeSingle: () => Promise.resolve({ data: { amount: 1200, season_key: null, entry_type: 'expense' }, error: null }) }) }) }),
					update: () => ({ eq: () => ({ is: () => ({ select: () => Promise.resolve({ data: null, error: periodMissing }) }) }) }),
				};
			}
			if (table === 'admin_finance_fixed_assets') {
				return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
			}
			return { select: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }) };
		});
		createServiceMock.mockResolvedValueOnce({ from } as never);
		const updated = await POST(new Request('http://localhost/api/admin/kpi/cost-profit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				operation: 'expense.update',
				fiscalYear: 2026,
				expenseId: 12,
				expense: { entryType: 'expense', date: '2028-01-10', category: '消耗品費', item: 'ペン', amount: 1200, paymentMethod: '現金' },
			}),
		}));
		expect(updated.status).toBe(409);
		expect(await updated.json()).toEqual({
			error: 'この日付の会計の期間がありません。先に期間を作ってください。',
			code: 'ACCOUNTING_PERIOD_MISSING',
		});
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
