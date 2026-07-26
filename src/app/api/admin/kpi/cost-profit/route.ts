import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { logAudit } from '@/lib/audit';
import { createServiceRoleClient } from '@/lib/supabase/server';

const seasonKeySchema = z.string().regex(/^\d{4}(SS|AW)$/);
// 会計期間は暦年。取引・決算はすべてこの軸で扱う（シーズンは商品原価専用）。
const fiscalYearSchema = z.coerce.number().int().min(2000).max(2999);
// 証憑（電子取引データ）の非公開バケット。
const RECEIPT_BUCKET = 'finance-receipts';
const moneySchema = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const entryTypeSchema = z.enum(['expense', 'income']).default('expense');

// 事業形態。勘定科目マスタ（src/lib/finance/accounts.ts）の適用形態と対応する。
const businessTypeSchema = z.enum(['soleProprietor', 'corporation']);

const expenseSchema = z.object({
	entryType: entryTypeSchema,
	date: z.string().date(),
	category: z.string().trim().min(1).max(80),
	item: z.string().trim().min(1).max(160),
	partner: z.string().trim().max(160).default(''),
	amount: moneySchema.min(1),
	paymentMethod: z.string().trim().min(1).max(80),
	memo: z.string().trim().max(500).default(''),
	// コレクション別分析用の任意タグ。会計期間は date から導出するので影響しない。
	seasonTag: seasonKeySchema.nullable().default(null),
});

const productSchema = z.object({
	id: z.string().trim().min(1).max(80),
	name: z.string().trim().min(1).max(160),
	category: z.string().trim().min(1).max(80),
	productionMethod: z.string().trim().min(1).max(80),
	plannedQuantity: z.coerce.number().int().min(0).max(1_000_000),
	sellingPrice: moneySchema,
	costs: z.object({
		material: moneySchema,
		sewing: moneySchema,
		pattern: moneySchema,
		accessories: moneySchema,
		processing: moneySchema,
		finishing: moneySchema,
	}),
});

// 固定資産台帳。資産は年度に属さない（取得日と耐用年数から毎年償却を算出する）。
const fixedAssetSchema = z.object({
	id: z.coerce.number().int().nonnegative().default(0),
	name: z.string().trim().min(1).max(160),
	account: z.string().trim().min(1).max(80),
	acquiredOn: z.string().date(),
	acquisitionCost: moneySchema.min(1),
	usefulLife: z.coerce.number().int().min(1).max(100),
	method: z.enum(['straightLine', 'lumpSum3Year', 'immediate']),
	businessUseRatio: z.coerce.number().int().min(1).max(100).default(100),
	disposedOn: z.string().date().nullable().default(null),
	memo: z.string().trim().max(500).default(''),
});

// 決算整理の入力値。期首棚卸は前年の期末棚卸なので入力させない。
const closingAdjustmentSchema = z.object({
	closingInventoryGoods: moneySchema,
	closingInventoryMaterials: moneySchema,
	allowanceForDoubtful: moneySchema,
});

// 期末残高スナップショット。{ 科目コード: 金額 }（normalSide 基準）。
const closingBalancesSchema = z.record(
	z.string().regex(/^\d{4}$/),
	z.coerce.number().int(),
);

const planSchema = z.object({
	salesRevenue: moneySchema,
	openingCash: moneySchema,
	accountsReceivable: moneySchema,
	fixedAssets: moneySchema,
	accountsPayable: moneySchema,
	openingCapital: moneySchema,
});

// 会計に関わる操作は年度（fiscalYear）で受け取る。シーズンを取るのは商品原価のみ。
const mutationSchema = z.discriminatedUnion('operation', [
	z.object({
		operation: z.literal('expense.create'),
		fiscalYear: fiscalYearSchema,
		expense: expenseSchema,
	}),
	z.object({
		operation: z.literal('expense.delete'),
		fiscalYear: fiscalYearSchema,
		expenseId: z.coerce.number().int().positive(),
	}),
	// 訂正。物理削除・再登録ではなく更新にして履歴を残す。
	z.object({
		operation: z.literal('expense.update'),
		fiscalYear: fiscalYearSchema,
		expenseId: z.coerce.number().int().positive(),
		expense: expenseSchema,
	}),
	// 証憑（電子取引データ）。ファイル本体は Storage、ここはメタデータ。
	z.object({
		operation: z.literal('receipt.attach'),
		expenseId: z.coerce.number().int().positive(),
		receipt: z.object({
			storagePath: z.string().trim().min(1).max(500),
			fileName: z.string().trim().min(1).max(255),
			mimeType: z.string().trim().min(1).max(120),
			fileSize: z.coerce.number().int().positive().max(20 * 1024 * 1024),
		}),
	}),
	z.object({
		operation: z.literal('receipt.delete'),
		receiptId: z.coerce.number().int().positive(),
	}),
	z.object({
		operation: z.literal('product.upsert'),
		seasonKey: seasonKeySchema,
		product: productSchema,
	}),
	z.object({
		operation: z.literal('plan.update'),
		fiscalYear: fiscalYearSchema,
		plan: planSchema,
	}),
	z.object({
		operation: z.literal('partner.create'),
		partnerName: z.string().trim().min(1).max(160),
	}),
	z.object({
		operation: z.literal('template.create'),
		template: z.object({
			name: z.string().trim().min(1).max(160),
			entryType: entryTypeSchema,
			category: z.string().trim().min(1).max(80),
			item: z.string().trim().min(1).max(160),
			amount: moneySchema,
			paymentMethod: z.string().trim().min(1).max(80),
			memo: z.string().trim().max(500).default(''),
		}),
	}),
	z.object({
		operation: z.literal('template.delete'),
		templateName: z.string().trim().min(1).max(160),
	}),
	z.object({
		operation: z.literal('businessType.update'),
		fiscalYear: fiscalYearSchema,
		businessType: businessTypeSchema,
	}),
	// 固定資産はグローバル（年度をまたいで償却する）。
	z.object({
		operation: z.literal('fixedAsset.upsert'),
		asset: fixedAssetSchema,
	}),
	z.object({
		operation: z.literal('fixedAsset.delete'),
		assetId: z.coerce.number().int().positive(),
	}),
	// 決算整理の入力値の保存（締めない）。
	z.object({
		operation: z.literal('closing.update'),
		fiscalYear: fiscalYearSchema,
		adjustment: closingAdjustmentSchema,
	}),
	// 年度締め。期末残高スナップショットを保存し、翌年度の期首残高として使う。
	z.object({
		operation: z.literal('closing.finalize'),
		fiscalYear: fiscalYearSchema,
		adjustment: closingAdjustmentSchema,
		closingBalances: closingBalancesSchema,
	}),
	// 締めの解除。スナップショットを破棄して再計算できる状態に戻す。
	z.object({
		operation: z.literal('closing.reopen'),
		fiscalYear: fiscalYearSchema,
	}),
]);

type FinancePlanRow = {
	fiscal_year: number;
	sales_revenue: number;
	opening_cash: number;
	accounts_receivable: number;
	fixed_assets: number;
	accounts_payable: number;
	opening_capital: number;
	business_type: BusinessType;
};

type BusinessType = z.infer<typeof businessTypeSchema>;

type EntryType = 'expense' | 'income';

type ExpenseRow = {
	id: number;
	entry_type: EntryType;
	expense_date: string;
	category: string;
	item_name: string;
	partner: string;
	amount: number;
	payment_method: string;
	memo: string;
	season_key: string | null;
	admin_finance_receipts?: ReceiptRow[] | null;
};

type ReceiptRow = {
	id: number;
	storage_path: string;
	file_name: string;
	mime_type: string;
	file_size: number;
	created_at: string;
};

type CumulativeEntryRow = {
	entry_type: EntryType;
	expense_date: string;
	category: string;
	amount: number;
};

type EntryRevisionRow = {
	id: number;
	entry_id: number;
	operation: 'insert' | 'update' | 'delete';
	before_data: Record<string, unknown> | null;
	after_data: Record<string, unknown> | null;
	changed_at: string;
};

type PartnerRow = {
	id: number;
	name: string;
};

type YearClosingRow = {
	fiscal_year: number;
	closing_inventory_goods: number;
	closing_inventory_materials: number;
	allowance_for_doubtful: number;
	closing_balances: Record<string, number> | null;
	closed_at: string | null;
};

type FixedAssetRow = {
	id: number;
	name: string;
	account: string;
	acquired_on: string;
	acquisition_cost: number;
	useful_life: number;
	method: 'straightLine' | 'lumpSum3Year' | 'immediate';
	business_use_ratio: number;
	disposed_on: string | null;
	memo: string;
};

type ExpenseTemplateRow = {
	name: string;
	entry_type: EntryType;
	category: string;
	item_name: string;
	amount: number;
	payment_method: string;
	memo: string;
};

type ProductRow = {
	sku: string;
	name: string;
	category: string;
	production_method: string;
	planned_quantity: number;
	selling_price: number;
	material_cost: number;
	sewing_cost: number;
	pattern_cost: number;
	accessories_cost: number;
	processing_cost: number;
	finishing_cost: number;
};

type SupabaseErrorLike = {
	code?: string;
	message?: string;
};

const EMPTY_PLAN = {
	salesRevenue: 0,
	openingCash: 0,
	accountsReceivable: 0,
	fixedAssets: 0,
	accountsPayable: 0,
	openingCapital: 0,
};

function isMissingFinanceTable(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false;
	const typed = error as SupabaseErrorLike;
	return typed.code === '42P01' || Boolean(typed.message?.includes('admin_finance_') || typed.message?.includes('admin_product_costs'));
}

function missingMigrationResponse() {
	return NextResponse.json(
		{
			error: '会計テーブルが未作成です。',
			details: 'migrations/062_create_admin_cost_profit_tables.sql 〜 069_finance_fiscal_year.sql をSupabaseへ適用してください。',
		},
		{ status: 503 },
	);
}

function mapPlan(row: FinancePlanRow | null) {
	if (!row) return EMPTY_PLAN;
	return {
		salesRevenue: Number(row.sales_revenue),
		openingCash: Number(row.opening_cash),
		accountsReceivable: Number(row.accounts_receivable),
		fixedAssets: Number(row.fixed_assets),
		accountsPayable: Number(row.accounts_payable),
		openingCapital: Number(row.opening_capital),
	};
}

function mapExpense(row: ExpenseRow) {
	return {
		id: Number(row.id),
		entryType: row.entry_type ?? 'expense',
		date: row.expense_date,
		category: row.category,
		item: row.item_name,
		partner: row.partner ?? '',
		amount: Number(row.amount),
		paymentMethod: row.payment_method,
		memo: row.memo,
		seasonTag: row.season_key ?? null,
		receipts: (row.admin_finance_receipts ?? []).map((receipt) => ({
			id: Number(receipt.id),
			storagePath: receipt.storage_path,
			fileName: receipt.file_name,
			mimeType: receipt.mime_type,
			fileSize: Number(receipt.file_size),
			createdAt: receipt.created_at,
		})),
	};
}

function mapRevision(row: EntryRevisionRow) {
	const pick = (data: Record<string, unknown> | null, key: string) =>
		data && data[key] !== undefined && data[key] !== null
			? String(data[key])
			: null;
	return {
		id: Number(row.id),
		entryId: Number(row.entry_id),
		operation: row.operation,
		changedAt: row.changed_at,
		before: {
			date: pick(row.before_data, 'expense_date'),
			category: pick(row.before_data, 'category'),
			item: pick(row.before_data, 'item_name'),
			partner: pick(row.before_data, 'partner'),
			amount: pick(row.before_data, 'amount'),
		},
		after: {
			date: pick(row.after_data, 'expense_date'),
			category: pick(row.after_data, 'category'),
			item: pick(row.after_data, 'item_name'),
			partner: pick(row.after_data, 'partner'),
			amount: pick(row.after_data, 'amount'),
		},
	};
}

function mapTemplate(row: ExpenseTemplateRow) {
	return {
		name: row.name,
		entryType: row.entry_type ?? 'expense',
		category: row.category,
		item: row.item_name,
		amount: Number(row.amount),
		paymentMethod: row.payment_method,
		memo: row.memo ?? '',
	};
}

const EMPTY_CLOSING = {
	closingInventoryGoods: 0,
	closingInventoryMaterials: 0,
	allowanceForDoubtful: 0,
	closingBalances: {} as Record<string, number>,
	closedAt: null as string | null,
};

function mapClosing(row: YearClosingRow | null) {
	if (!row) return EMPTY_CLOSING;
	return {
		closingInventoryGoods: Number(row.closing_inventory_goods),
		closingInventoryMaterials: Number(row.closing_inventory_materials),
		allowanceForDoubtful: Number(row.allowance_for_doubtful),
		closingBalances: row.closing_balances ?? {},
		closedAt: row.closed_at,
	};
}

function mapFixedAsset(row: FixedAssetRow) {
	return {
		id: Number(row.id),
		name: row.name,
		account: row.account,
		acquiredOn: row.acquired_on,
		acquisitionCost: Number(row.acquisition_cost),
		usefulLife: Number(row.useful_life),
		method: row.method,
		businessUseRatio: Number(row.business_use_ratio),
		disposedOn: row.disposed_on,
		memo: row.memo ?? '',
	};
}

function mapProduct(row: ProductRow) {
	return {
		id: row.sku,
		name: row.name,
		category: row.category,
		productionMethod: row.production_method,
		plannedQuantity: Number(row.planned_quantity),
		sellingPrice: Number(row.selling_price),
		costs: {
			material: Number(row.material_cost),
			sewing: Number(row.sewing_cost),
			pattern: Number(row.pattern_cost),
			accessories: Number(row.accessories_cost),
			processing: Number(row.processing_cost),
			finishing: Number(row.finishing_cost),
		},
	};
}

async function applyCsrfProtection() {
	const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
	return requireCsrfOrDeny();
}

function isRotatedCsrf(value: unknown): value is { rotatedCsrfToken: string } {
	return Boolean(
		value
		&& typeof value === 'object'
		&& 'rotatedCsrfToken' in value
		&& typeof (value as { rotatedCsrfToken?: unknown }).rotatedCsrfToken === 'string',
	);
}

async function attachRotatedCsrf(response: NextResponse, csrfResult: unknown) {
	if (!isRotatedCsrf(csrfResult)) return response;
	const { csrfCookieName, csrfCookieMaxAgeSeconds, cookieOptionsForCsrf } = await import('@/lib/cookie');
	response.cookies.set({
		name: csrfCookieName,
		value: csrfResult.rotatedCsrfToken,
		...cookieOptionsForCsrf(csrfCookieMaxAgeSeconds),
	});
	return response;
}

export async function GET(request: Request) {
	try {
		const authz = await authorizeAdminPermission('admin.finance.read', request);
		if (!authz.ok) return authz.response;

		const url = new URL(request.url);
		// 会計データは年度（必須）で取得する。シーズンは商品原価の絞り込みにのみ使う（任意）。
		const parsedYear = fiscalYearSchema.safeParse(url.searchParams.get('year'));
		if (!parsedYear.success) {
			return NextResponse.json({ error: 'Invalid year' }, { status: 400 });
		}
		const seasonParam = url.searchParams.get('season');
		const parsedSeason = seasonParam ? seasonKeySchema.safeParse(seasonParam) : null;
		if (parsedSeason && !parsedSeason.success) {
			return NextResponse.json({ error: 'Invalid season' }, { status: 400 });
		}
		const seasonKey = parsedSeason?.success ? parsedSeason.data : null;

		const supabase = await createServiceRoleClient();
		const [
			planResult,
			expensesResult,
			productsResult,
			partnersResult,
			templatesResult,
			assetsResult,
			closingsResult,
			revisionsResult,
			cumulativeResult,
		] = await Promise.all([
			supabase
				.from('admin_finance_years')
				.select('fiscal_year, sales_revenue, opening_cash, accounts_receivable, fixed_assets, accounts_payable, opening_capital, business_type')
				.eq('fiscal_year', parsedYear.data)
				.maybeSingle(),
			// 論理削除された取引は集計・表示から除く（履歴には残る）。
			supabase
				.from('admin_finance_expenses')
				.select('id, entry_type, expense_date, category, item_name, partner, amount, payment_method, memo, season_key, admin_finance_receipts(id, storage_path, file_name, mime_type, file_size, created_at)')
				.eq('fiscal_year', parsedYear.data)
				.is('deleted_at', null)
				.order('expense_date', { ascending: false })
				.order('id', { ascending: false }),
			seasonKey
				? supabase
					.from('admin_product_costs')
					.select('sku, name, category, production_method, planned_quantity, selling_price, material_cost, sewing_cost, pattern_cost, accessories_cost, processing_cost, finishing_cost')
					.eq('season_key', seasonKey)
					.order('sku', { ascending: true })
				: Promise.resolve({ data: [], error: null }),
			// 取引先マスタはシーズン非依存（グローバル）。
			supabase
				.from('admin_finance_partners')
				.select('id, name')
				.order('name', { ascending: true }),
			// 経費入力テンプレートもシーズン非依存（グローバル）。
			supabase
				.from('admin_finance_expense_templates')
				.select('name, entry_type, category, item_name, amount, payment_method, memo')
				.order('name', { ascending: true }),
			// 固定資産台帳もグローバル。年度をまたいで償却するため年で絞らない。
			supabase
				.from('admin_finance_fixed_assets')
				.select('id, name, account, acquired_on, acquisition_cost, useful_life, method, business_use_ratio, disposed_on, memo')
				.order('acquired_on', { ascending: true })
				.order('id', { ascending: true }),
			// 当年度と前年度の決算。前年度のスナップショットが当年度の期首残高になる。
			supabase
				.from('admin_finance_year_closings')
				.select('fiscal_year, closing_inventory_goods, closing_inventory_materials, allowance_for_doubtful, closing_balances, closed_at')
				.in('fiscal_year', [parsedYear.data - 1, parsedYear.data]),
			// 訂正削除履歴（電子帳簿保存法の真実性の要件）。直近200件を返す。
			supabase
				.from('admin_finance_entry_revisions')
				.select('id, entry_id, operation, before_data, after_data, changed_at')
				.order('changed_at', { ascending: false })
				.order('id', { ascending: false })
				.limit(200),
			// 開業以来累計の集計用。損益の判定に必要な最小限の列だけを取る。
			supabase
				.from('admin_finance_expenses')
				.select('entry_type, expense_date, category, amount')
				.lte('expense_date', `${parsedYear.data}-12-31`)
				.is('deleted_at', null),
		]);

		const queryError =
			planResult.error || expensesResult.error || productsResult.error || partnersResult.error || templatesResult.error
			|| assetsResult.error || closingsResult.error || revisionsResult.error || cumulativeResult.error;
		if (queryError) {
			if (isMissingFinanceTable(queryError)) return missingMigrationResponse();
			console.error('GET /api/admin/kpi/cost-profit query error:', queryError);
			return NextResponse.json({ error: '会計データの取得に失敗しました。' }, { status: 500 });
		}

		const entries = ((expensesResult.data ?? []) as ExpenseRow[]).map(mapExpense);
		const planRow = (planResult.data as FinancePlanRow | null) ?? null;

		const closingRows = (closingsResult.data ?? []) as YearClosingRow[];
		const currentClosing = closingRows.find((row) => Number(row.fiscal_year) === parsedYear.data) ?? null;
		const previousClosing = closingRows.find((row) => Number(row.fiscal_year) === parsedYear.data - 1) ?? null;

		return NextResponse.json({
			data: {
				fiscalYear: parsedYear.data,
				seasonKey,
				businessType: planRow?.business_type ?? 'soleProprietor',
				plan: mapPlan(planRow),
				expenses: entries.filter((entry) => entry.entryType === 'expense'),
				incomes: entries.filter((entry) => entry.entryType === 'income'),
				products: ((productsResult.data ?? []) as ProductRow[]).map(mapProduct),
				partners: ((partnersResult.data ?? []) as PartnerRow[]).map((row) => row.name),
				fixedAssets: ((assetsResult.data ?? []) as FixedAssetRow[]).map(mapFixedAsset),
				closing: mapClosing(currentClosing),
				// 前年度の期末残高スナップショット。存在すれば当年度の期首残高として使う。
				previousClosingBalances: previousClosing?.closing_balances ?? null,
				revisions: ((revisionsResult.data ?? []) as EntryRevisionRow[]).map(mapRevision),
				cumulativeEntries: ((cumulativeResult.data ?? []) as CumulativeEntryRow[]).map((row) => ({
					entryType: row.entry_type ?? 'expense',
					date: row.expense_date,
					category: row.category,
					amount: Number(row.amount),
				})),
				templates: ((templatesResult.data ?? []) as ExpenseTemplateRow[]).map(mapTemplate),
			},
		});
	} catch (error) {
		console.error('GET /api/admin/kpi/cost-profit error:', error);
		return NextResponse.json({ error: '会計データの取得に失敗しました。' }, { status: 500 });
	}
}

export async function POST(request: Request) {
	let authz: Awaited<ReturnType<typeof authorizeAdminPermission>> | null = null;
	let operation = 'unknown';

	try {
		authz = await authorizeAdminPermission('admin.finance.manage', request);
		if (!authz.ok) return authz.response;

		const csrfResult = await applyCsrfProtection();
		if (csrfResult instanceof Response) return csrfResult;

		const body = await request.json().catch(() => null);
		const parsed = mutationSchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json(
				{ error: 'Invalid request', details: parsed.error.flatten() },
				{ status: 400 },
			);
		}

		operation = parsed.data.operation;
		const supabase = await createServiceRoleClient();
		// 監査ログ用のスコープ表示。年度ベースの操作は年、商品原価はシーズン。
		const scopeLabel = 'fiscalYear' in parsed.data
			? String(parsed.data.fiscalYear)
			: 'seasonKey' in parsed.data
				? parsed.data.seasonKey
				: 'global';
		let resourceId = scopeLabel;

		if (parsed.data.operation === 'expense.create') {
			// 年度レコードを先に用意する（事業形態・期首残高の入れ物）。
			const { error: yearError } = await supabase
				.from('admin_finance_years')
				.upsert(
					{ fiscal_year: parsed.data.fiscalYear },
					{ onConflict: 'fiscal_year', ignoreDuplicates: true },
				);
			if (yearError) throw yearError;

			const expense = parsed.data.expense;
			// シーズンタグを付ける場合は登録簿へ先に登録しておく（FK）。
			if (expense.seasonTag) {
				const { error: seasonError } = await supabase
					.from('admin_finance_seasons')
					.upsert(
						{ season_key: expense.seasonTag },
						{ onConflict: 'season_key', ignoreDuplicates: true },
					);
				if (seasonError) throw seasonError;
			}

			const { data, error } = await supabase
				.from('admin_finance_expenses')
				.insert({
					season_key: expense.seasonTag,
					entry_type: expense.entryType,
					expense_date: expense.date,
					category: expense.category,
					item_name: expense.item,
					partner: expense.partner,
					amount: expense.amount,
					payment_method: expense.paymentMethod,
					memo: expense.memo,
					created_by: authz.userId,
				})
				.select('id, fiscal_year')
				.single();

			if (error) throw error;
			resourceId = String(data.id);
		} else if (parsed.data.operation === 'expense.delete') {
			// 電子帳簿保存法の真実性の要件のため物理削除しない（論理削除＋履歴）。
			const { data, error } = await supabase
				.from('admin_finance_expenses')
				.update({
					deleted_at: new Date().toISOString(),
					deleted_by: authz.userId,
					updated_by: authz.userId,
				})
				.eq('id', parsed.data.expenseId)
				.eq('fiscal_year', parsed.data.fiscalYear)
				.is('deleted_at', null)
				.select('id');

			if (error) throw error;
			if (!data?.length) {
				return NextResponse.json({ error: '取引が見つかりません。' }, { status: 404 });
			}
			resourceId = String(parsed.data.expenseId);
		} else if (parsed.data.operation === 'expense.update') {
			const expense = parsed.data.expense;
			if (expense.seasonTag) {
				const { error: seasonError } = await supabase
					.from('admin_finance_seasons')
					.upsert(
						{ season_key: expense.seasonTag },
						{ onConflict: 'season_key', ignoreDuplicates: true },
					);
				if (seasonError) throw seasonError;
			}

			const { data, error } = await supabase
				.from('admin_finance_expenses')
				.update({
					season_key: expense.seasonTag,
					entry_type: expense.entryType,
					expense_date: expense.date,
					category: expense.category,
					item_name: expense.item,
					partner: expense.partner,
					amount: expense.amount,
					payment_method: expense.paymentMethod,
					memo: expense.memo,
					updated_by: authz.userId,
				})
				.eq('id', parsed.data.expenseId)
				.is('deleted_at', null)
				.select('id');

			if (error) throw error;
			if (!data?.length) {
				return NextResponse.json({ error: '取引が見つかりません。' }, { status: 404 });
			}
			resourceId = String(parsed.data.expenseId);
		} else if (parsed.data.operation === 'receipt.attach') {
			// 証憑のメタデータ登録。ファイル本体は Storage へ別途アップロード済み。
			const receipt = parsed.data.receipt;
			const { data, error } = await supabase
				.from('admin_finance_receipts')
				.insert({
					entry_id: parsed.data.expenseId,
					storage_path: receipt.storagePath,
					file_name: receipt.fileName,
					mime_type: receipt.mimeType,
					file_size: receipt.fileSize,
					uploaded_by: authz.userId,
				})
				.select('id')
				.single();

			if (error) throw error;
			resourceId = String(data.id);
		} else if (parsed.data.operation === 'receipt.delete') {
			const { data, error } = await supabase
				.from('admin_finance_receipts')
				.delete()
				.eq('id', parsed.data.receiptId)
				.select('storage_path');

			if (error) throw error;
			if (!data?.length) {
				return NextResponse.json({ error: '証憑が見つかりません。' }, { status: 404 });
			}
			// Storage 側のファイルも消す。メタデータが消えた後は参照できないため。
			await supabase.storage.from(RECEIPT_BUCKET).remove([data[0].storage_path]);
			resourceId = String(parsed.data.receiptId);
		} else if (parsed.data.operation === 'product.upsert') {
			const { error: seasonError } = await supabase
				.from('admin_finance_seasons')
				.upsert(
					{ season_key: parsed.data.seasonKey },
					{ onConflict: 'season_key', ignoreDuplicates: true },
				);
			if (seasonError) throw seasonError;

			const product = parsed.data.product;
			const { error } = await supabase
				.from('admin_product_costs')
				.upsert({
					season_key: parsed.data.seasonKey,
					sku: product.id,
					name: product.name,
					category: product.category,
					production_method: product.productionMethod,
					planned_quantity: product.plannedQuantity,
					selling_price: product.sellingPrice,
					material_cost: product.costs.material,
					sewing_cost: product.costs.sewing,
					pattern_cost: product.costs.pattern,
					accessories_cost: product.costs.accessories,
					processing_cost: product.costs.processing,
					finishing_cost: product.costs.finishing,
					created_by: authz.userId,
				}, { onConflict: 'season_key,sku' });

			if (error) throw error;
			resourceId = `${parsed.data.seasonKey}:${product.id}`;
		} else if (parsed.data.operation === 'partner.create') {
			// 取引先マスタはシーズン非依存（グローバル）。既存名は重複無視。
			const { error } = await supabase
				.from('admin_finance_partners')
				.upsert(
					{ name: parsed.data.partnerName, created_by: authz.userId },
					{ onConflict: 'name', ignoreDuplicates: true },
				);

			if (error) throw error;
			resourceId = parsed.data.partnerName;
		} else if (parsed.data.operation === 'template.create') {
			// 経費入力テンプレート（グローバル）。同名は上書き（編集）。
			const template = parsed.data.template;
			const { error } = await supabase
				.from('admin_finance_expense_templates')
				.upsert(
					{
						name: template.name,
						entry_type: template.entryType,
						category: template.category,
						item_name: template.item,
						amount: template.amount,
						payment_method: template.paymentMethod,
						memo: template.memo,
						created_by: authz.userId,
					},
					{ onConflict: 'name' },
				);

			if (error) throw error;
			resourceId = template.name;
		} else if (parsed.data.operation === 'template.delete') {
			const { error } = await supabase
				.from('admin_finance_expense_templates')
				.delete()
				.eq('name', parsed.data.templateName);

			if (error) throw error;
			resourceId = parsed.data.templateName;
		} else if (parsed.data.operation === 'fixedAsset.upsert') {
			// id=0 は新規登録。既存 id は更新。
			const asset = parsed.data.asset;
			const payload = {
				name: asset.name,
				account: asset.account,
				acquired_on: asset.acquiredOn,
				acquisition_cost: asset.acquisitionCost,
				useful_life: asset.usefulLife,
				method: asset.method,
				business_use_ratio: asset.businessUseRatio,
				disposed_on: asset.disposedOn,
				memo: asset.memo,
			};

			if (asset.id > 0) {
				const { data, error } = await supabase
					.from('admin_finance_fixed_assets')
					.update(payload)
					.eq('id', asset.id)
					.select('id');
				if (error) throw error;
				if (!data?.length) {
					return NextResponse.json({ error: '固定資産が見つかりません。' }, { status: 404 });
				}
				resourceId = String(asset.id);
			} else {
				const { data, error } = await supabase
					.from('admin_finance_fixed_assets')
					.insert({ ...payload, created_by: authz.userId })
					.select('id')
					.single();
				if (error) throw error;
				resourceId = String(data.id);
			}
		} else if (parsed.data.operation === 'fixedAsset.delete') {
			const { data, error } = await supabase
				.from('admin_finance_fixed_assets')
				.delete()
				.eq('id', parsed.data.assetId)
				.select('id');

			if (error) throw error;
			if (!data?.length) {
				return NextResponse.json({ error: '固定資産が見つかりません。' }, { status: 404 });
			}
			resourceId = String(parsed.data.assetId);
		} else if (
			parsed.data.operation === 'closing.update'
			|| parsed.data.operation === 'closing.finalize'
		) {
			// 年度レコードが無いと FK で落ちるので先に用意する。
			const { error: yearError } = await supabase
				.from('admin_finance_years')
				.upsert(
					{ fiscal_year: parsed.data.fiscalYear },
					{ onConflict: 'fiscal_year', ignoreDuplicates: true },
				);
			if (yearError) throw yearError;

			const adjustment = parsed.data.adjustment;
			// 締めるときだけスナップショットと締め日時を書き込む。
			const finalizeFields = parsed.data.operation === 'closing.finalize'
				? {
					closing_balances: parsed.data.closingBalances,
					closed_at: new Date().toISOString(),
					closed_by: authz.userId,
				}
				: {};

			const { error } = await supabase
				.from('admin_finance_year_closings')
				.upsert(
					{
						fiscal_year: parsed.data.fiscalYear,
						closing_inventory_goods: adjustment.closingInventoryGoods,
						closing_inventory_materials: adjustment.closingInventoryMaterials,
						allowance_for_doubtful: adjustment.allowanceForDoubtful,
						...finalizeFields,
					},
					{ onConflict: 'fiscal_year' },
				);

			if (error) throw error;
		} else if (parsed.data.operation === 'closing.reopen') {
			// 締めを解除。スナップショットを破棄して再計算できる状態へ戻す。
			const { data, error } = await supabase
				.from('admin_finance_year_closings')
				.update({ closing_balances: {}, closed_at: null, closed_by: null })
				.eq('fiscal_year', parsed.data.fiscalYear)
				.select('fiscal_year');

			if (error) throw error;
			if (!data?.length) {
				return NextResponse.json({ error: '決算が見つかりません。' }, { status: 404 });
			}
		} else if (parsed.data.operation === 'businessType.update') {
			// 事業形態は年度に属する（法人成りに備えて年度単位で保持）。
			const { error } = await supabase
				.from('admin_finance_years')
				.upsert(
					{
						fiscal_year: parsed.data.fiscalYear,
						business_type: parsed.data.businessType,
					},
					{ onConflict: 'fiscal_year' },
				);

			if (error) throw error;
		} else {
			// 期首残高・売上目標も年度に属する。
			const plan = parsed.data.plan;
			const { error } = await supabase
				.from('admin_finance_years')
				.upsert({
					fiscal_year: parsed.data.fiscalYear,
					sales_revenue: plan.salesRevenue,
					opening_cash: plan.openingCash,
					accounts_receivable: plan.accountsReceivable,
					fixed_assets: plan.fixedAssets,
					accounts_payable: plan.accountsPayable,
					opening_capital: plan.openingCapital,
				}, { onConflict: 'fiscal_year' });

			if (error) throw error;
		}

		await logAudit({
			action: `admin.finance.${operation}`,
			actor_id: authz.userId,
			actor_email: authz.actorEmail,
			resource: 'finance',
			resource_id: resourceId,
			outcome: 'success',
			detail: `Updated finance data for ${scopeLabel}`,
			ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
			user_agent: request.headers.get('user-agent') ?? null,
			metadata: { operation, scope: scopeLabel },
		});

		return attachRotatedCsrf(NextResponse.json({ success: true }), csrfResult);
	} catch (error) {
		if (isMissingFinanceTable(error)) return missingMigrationResponse();

		console.error('POST /api/admin/kpi/cost-profit error:', error);
		if (authz?.ok) {
			await logAudit({
				action: `admin.finance.${operation}`,
				actor_id: authz.userId,
				actor_email: authz.actorEmail,
				resource: 'finance',
				outcome: 'failure',
				detail: error instanceof Error ? error.message : 'Finance update failed',
				metadata: { operation },
			});
		}
		return NextResponse.json({ error: '会計データの保存に失敗しました。' }, { status: 500 });
	}
}
