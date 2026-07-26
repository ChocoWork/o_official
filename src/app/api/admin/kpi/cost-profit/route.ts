import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { logAudit } from '@/lib/audit';
import { createServiceRoleClient } from '@/lib/supabase/server';

const seasonKeySchema = z.string().regex(/^\d{4}(SS|AW)$/);
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

const planSchema = z.object({
	salesRevenue: moneySchema,
	openingCash: moneySchema,
	accountsReceivable: moneySchema,
	fixedAssets: moneySchema,
	accountsPayable: moneySchema,
	openingCapital: moneySchema,
});

const mutationSchema = z.discriminatedUnion('operation', [
	z.object({
		operation: z.literal('expense.create'),
		seasonKey: seasonKeySchema,
		expense: expenseSchema,
	}),
	z.object({
		operation: z.literal('expense.delete'),
		seasonKey: seasonKeySchema,
		expenseId: z.coerce.number().int().positive(),
	}),
	z.object({
		operation: z.literal('product.upsert'),
		seasonKey: seasonKeySchema,
		product: productSchema,
	}),
	z.object({
		operation: z.literal('plan.update'),
		seasonKey: seasonKeySchema,
		plan: planSchema,
	}),
	z.object({
		operation: z.literal('partner.create'),
		seasonKey: seasonKeySchema,
		partnerName: z.string().trim().min(1).max(160),
	}),
	z.object({
		operation: z.literal('template.create'),
		seasonKey: seasonKeySchema,
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
		seasonKey: seasonKeySchema,
		templateName: z.string().trim().min(1).max(160),
	}),
	z.object({
		operation: z.literal('businessType.update'),
		seasonKey: seasonKeySchema,
		businessType: businessTypeSchema,
	}),
]);

type FinancePlanRow = {
	season_key: string;
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
};

type PartnerRow = {
	id: number;
	name: string;
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
			details: 'migrations/062_create_admin_cost_profit_tables.sql をSupabaseへ適用してください。',
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
		const parsedSeason = seasonKeySchema.safeParse(url.searchParams.get('season'));
		if (!parsedSeason.success) {
			return NextResponse.json({ error: 'Invalid season' }, { status: 400 });
		}

		const supabase = await createServiceRoleClient();
		const [planResult, expensesResult, productsResult, partnersResult, templatesResult] = await Promise.all([
			supabase
				.from('admin_finance_seasons')
				.select('season_key, sales_revenue, opening_cash, accounts_receivable, fixed_assets, accounts_payable, opening_capital, business_type')
				.eq('season_key', parsedSeason.data)
				.maybeSingle(),
			supabase
				.from('admin_finance_expenses')
				.select('id, entry_type, expense_date, category, item_name, partner, amount, payment_method, memo')
				.eq('season_key', parsedSeason.data)
				.order('expense_date', { ascending: false })
				.order('id', { ascending: false }),
			supabase
				.from('admin_product_costs')
				.select('sku, name, category, production_method, planned_quantity, selling_price, material_cost, sewing_cost, pattern_cost, accessories_cost, processing_cost, finishing_cost')
				.eq('season_key', parsedSeason.data)
				.order('sku', { ascending: true }),
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
		]);

		const queryError =
			planResult.error || expensesResult.error || productsResult.error || partnersResult.error || templatesResult.error;
		if (queryError) {
			if (isMissingFinanceTable(queryError)) return missingMigrationResponse();
			console.error('GET /api/admin/kpi/cost-profit query error:', queryError);
			return NextResponse.json({ error: '会計データの取得に失敗しました。' }, { status: 500 });
		}

		const entries = ((expensesResult.data ?? []) as ExpenseRow[]).map(mapExpense);
		const planRow = (planResult.data as FinancePlanRow | null) ?? null;

		return NextResponse.json({
			data: {
				seasonKey: parsedSeason.data,
				businessType: planRow?.business_type ?? 'soleProprietor',
				plan: mapPlan(planRow),
				expenses: entries.filter((entry) => entry.entryType === 'expense'),
				incomes: entries.filter((entry) => entry.entryType === 'income'),
				products: ((productsResult.data ?? []) as ProductRow[]).map(mapProduct),
				partners: ((partnersResult.data ?? []) as PartnerRow[]).map((row) => row.name),
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
		let resourceId = parsed.data.seasonKey;

		if (parsed.data.operation === 'expense.create') {
			const { error: seasonError } = await supabase
				.from('admin_finance_seasons')
				.upsert(
					{ season_key: parsed.data.seasonKey },
					{ onConflict: 'season_key', ignoreDuplicates: true },
				);
			if (seasonError) throw seasonError;

			const expense = parsed.data.expense;
			const { data, error } = await supabase
				.from('admin_finance_expenses')
				.insert({
					season_key: parsed.data.seasonKey,
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
				.select('id, entry_type, expense_date, category, item_name, partner, amount, payment_method, memo')
				.single();

			if (error) throw error;
			resourceId = String(data.id);
		} else if (parsed.data.operation === 'expense.delete') {
			const { data, error } = await supabase
				.from('admin_finance_expenses')
				.delete()
				.eq('id', parsed.data.expenseId)
				.eq('season_key', parsed.data.seasonKey)
				.select('id');

			if (error) throw error;
			if (!data?.length) {
				return NextResponse.json({ error: '経費が見つかりません。' }, { status: 404 });
			}
			resourceId = String(parsed.data.expenseId);
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
		} else if (parsed.data.operation === 'businessType.update') {
			const { error } = await supabase
				.from('admin_finance_seasons')
				.upsert(
					{
						season_key: parsed.data.seasonKey,
						business_type: parsed.data.businessType,
					},
					{ onConflict: 'season_key' },
				);

			if (error) throw error;
		} else {
			const plan = parsed.data.plan;
			const { error } = await supabase
				.from('admin_finance_seasons')
				.upsert({
					season_key: parsed.data.seasonKey,
					sales_revenue: plan.salesRevenue,
					opening_cash: plan.openingCash,
					accounts_receivable: plan.accountsReceivable,
					fixed_assets: plan.fixedAssets,
					accounts_payable: plan.accountsPayable,
					opening_capital: plan.openingCapital,
				}, { onConflict: 'season_key' });

			if (error) throw error;
		}

		await logAudit({
			action: `admin.finance.${operation}`,
			actor_id: authz.userId,
			actor_email: authz.actorEmail,
			resource: 'finance',
			resource_id: resourceId,
			outcome: 'success',
			detail: `Updated finance data for ${parsed.data.seasonKey}`,
			ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
			user_agent: request.headers.get('user-agent') ?? null,
			metadata: { operation, season_key: parsed.data.seasonKey },
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
