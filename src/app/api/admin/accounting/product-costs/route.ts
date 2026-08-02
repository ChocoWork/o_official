import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { logAudit } from '@/lib/audit';
import { calculateProductCosting, PRODUCT_CATEGORIES, PRODUCT_COST_TYPES } from '@/lib/finance/product-costing';
import type { CostAllocation, CostingExpense, CostingItem, ProductCategory, ProductCostType } from '@/lib/finance/product-costing';
import { createServiceRoleClient } from '@/lib/supabase/server';

const seasonSchema = z.string().regex(/^\d{4}(SS|AW)$/);
const moneySchema = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const itemSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  seasonKey: seasonSchema,
  category: z.enum(PRODUCT_CATEGORIES),
  provisionalName: z.string().trim().min(1).max(160),
  plannedQuantity: z.coerce.number().int().min(0).max(1_000_000).default(0),
  sellingPrice: moneySchema.default(0),
  fabricMetersPerUnit: z.coerce.number().min(0).max(1_000_000).default(0),
});
const allocationLineSchema = z.object({
  targetType: z.enum(['item', 'season_common']),
  itemId: z.coerce.number().int().positive().nullable(),
  costType: z.enum(PRODUCT_COST_TYPES),
  otherLabel: z.string().trim().min(1).max(80).nullable(),
  amount: moneySchema.min(1),
}).superRefine((line, context) => {
  if (line.targetType === 'item' && line.itemId === null) {
    context.addIssue({ code: 'custom', path: ['itemId'], message: '商品を選択してください。' });
  }
  if (line.targetType === 'season_common' && line.itemId !== null) {
    context.addIssue({ code: 'custom', path: ['itemId'], message: '共通費に商品は指定できません。' });
  }
  if (line.costType === 'other' && !line.otherLabel) {
    context.addIssue({ code: 'custom', path: ['otherLabel'], message: 'その他の費用名を入力してください。' });
  }
});
const mutationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('item.create'), item: itemSchema.omit({ id: true }) }),
  z.object({ operation: z.literal('item.update'), item: itemSchema.required({ id: true }) }),
  z.object({
    operation: z.literal('allocation.replace'),
    expenseId: z.coerce.number().int().positive(),
    lines: z.array(allocationLineSchema).min(1).max(100),
  }),
  z.object({ operation: z.literal('allocation.clear'), expenseId: z.coerce.number().int().positive() }),
]);

type ItemRow = {
  id: number; season_key: string; category: ProductCategory; provisional_name: string;
  planned_quantity: number; selling_price: number; fabric_meters_per_unit: number; updated_at: string;
};
type ExpenseRow = {
  id: number; expense_date: string; category: string; item_name: string; partner: string; amount: number;
};
type AllocationRow = {
  id: number; expense_id: number; season_key: string; target_type: 'item' | 'season_common';
  item_id: number | null; cost_type: ProductCostType; other_label: string | null; amount: number;
};

async function applyCsrfProtection() {
  const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
  return requireCsrfOrDeny();
}

function isRotatedCsrf(value: unknown): value is { rotatedCsrfToken: string } {
  return Boolean(value && typeof value === 'object' && 'rotatedCsrfToken' in value
    && typeof (value as { rotatedCsrfToken?: unknown }).rotatedCsrfToken === 'string');
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
  const authz = await authorizeAdminPermission('admin.finance.read', request);
  if (!authz.ok) return authz.response;
  const parsedSeason = seasonSchema.safeParse(new URL(request.url).searchParams.get('season'));
  if (!parsedSeason.success) return NextResponse.json({ error: 'シーズンが正しくありません。' }, { status: 400 });

  try {
    const supabase = await createServiceRoleClient();
    const [itemsResult, expensesResult, allocationsResult] = await Promise.all([
      supabase.from('admin_costing_items')
        .select('id, season_key, category, provisional_name, planned_quantity, selling_price, fabric_meters_per_unit, updated_at')
        .eq('season_key', parsedSeason.data).order('id'),
      supabase.from('admin_finance_expenses')
        .select('id, expense_date, category, item_name, partner, amount')
        .eq('season_key', parsedSeason.data).eq('entry_type', 'expense').is('deleted_at', null)
        .order('expense_date', { ascending: false }).order('id', { ascending: false }),
      supabase.from('admin_expense_cost_allocations')
        .select('id, expense_id, season_key, target_type, item_id, cost_type, other_label, amount')
        .eq('season_key', parsedSeason.data).order('id'),
    ]);
    const queryError = itemsResult.error || expensesResult.error || allocationsResult.error;
    if (queryError) throw queryError;

    const items: CostingItem[] = ((itemsResult.data ?? []) as ItemRow[]).map((row) => ({
      id: Number(row.id), seasonKey: row.season_key, category: row.category,
      provisionalName: row.provisional_name, plannedQuantity: Number(row.planned_quantity),
      sellingPrice: Number(row.selling_price), fabricMetersPerUnit: Number(row.fabric_meters_per_unit),
      updatedAt: row.updated_at,
    }));
    const expenses: Array<Omit<CostingExpense, 'allocations' | 'allocated'>> = ((expensesResult.data ?? []) as ExpenseRow[]).map((row) => ({
      id: Number(row.id), date: row.expense_date, category: row.category, item: row.item_name,
      partner: row.partner ?? '', amount: Number(row.amount),
    }));
    const allocations: CostAllocation[] = ((allocationsResult.data ?? []) as AllocationRow[]).map((row) => ({
      id: Number(row.id), expenseId: Number(row.expense_id), seasonKey: row.season_key,
      targetType: row.target_type, itemId: row.item_id === null ? null : Number(row.item_id),
      costType: row.cost_type, otherLabel: row.other_label, amount: Number(row.amount),
    }));
    return NextResponse.json({ data: { seasonKey: parsedSeason.data, ...calculateProductCosting(items, expenses, allocations) } });
  } catch (error) {
    console.error('GET /api/admin/accounting/product-costs error:', error);
    return NextResponse.json({ error: '商品原価データの取得に失敗しました。' }, { status: 500 });
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
    const parsed = mutationSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: '入力内容を確認してください。', details: parsed.error.flatten() }, { status: 400 });
    }
    operation = parsed.data.operation;
    const supabase = await createServiceRoleClient();
    let resourceId = '';
    if (parsed.data.operation === 'item.create' || parsed.data.operation === 'item.update') {
      const item = parsed.data.item;
      const { error: seasonError } = await supabase.from('admin_finance_seasons')
        .upsert({ season_key: item.seasonKey }, { onConflict: 'season_key', ignoreDuplicates: true });
      if (seasonError) throw seasonError;
      const values = {
        season_key: item.seasonKey, category: item.category, provisional_name: item.provisionalName,
        planned_quantity: item.plannedQuantity, selling_price: item.sellingPrice,
        fabric_meters_per_unit: item.fabricMetersPerUnit,
      };
      if (parsed.data.operation === 'item.create') {
        const { data, error } = await supabase.from('admin_costing_items')
          .insert({ ...values, created_by: authz.userId }).select('id').single();
        if (error) throw error;
        resourceId = String(data.id);
      } else {
        const itemId = parsed.data.item.id;
        const { data, error } = await supabase.from('admin_costing_items').update(values)
          .eq('id', itemId).eq('season_key', item.seasonKey).select('id');
        if (error) throw error;
        if (!data?.length) return NextResponse.json({ error: '商品が見つかりません。' }, { status: 404 });
        resourceId = String(itemId);
      }
    } else if (parsed.data.operation === 'allocation.replace') {
      const { error } = await supabase.rpc('replace_admin_expense_cost_allocations', {
        p_expense_id: parsed.data.expenseId, p_lines: parsed.data.lines, p_created_by: authz.userId,
      });
      if (error) throw error;
      resourceId = String(parsed.data.expenseId);
    } else {
      const { error } = await supabase.rpc('clear_admin_expense_cost_allocations', {
        p_expense_id: parsed.data.expenseId,
      });
      if (error) throw error;
      resourceId = String(parsed.data.expenseId);
    }

    await logAudit({
      action: `admin.finance.productCost.${operation}`, actor_id: authz.userId,
      actor_email: authz.actorEmail, resource: 'product-cost', resource_id: resourceId,
      outcome: 'success', detail: `Completed ${operation}`,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      user_agent: request.headers.get('user-agent') ?? null, metadata: { operation },
    });
    return attachRotatedCsrf(NextResponse.json({ success: true, resourceId }), csrfResult);
  } catch (error) {
    console.error('POST /api/admin/accounting/product-costs error:', error);
    if (authz?.ok) {
      await logAudit({
        action: `admin.finance.productCost.${operation}`, actor_id: authz.userId,
        actor_email: authz.actorEmail, resource: 'product-cost', outcome: 'failure',
        detail: error instanceof Error ? error.message : 'Product costing update failed', metadata: { operation },
      });
    }
    const message = error instanceof Error ? error.message : '';
    const isConflict = /allocation|配賦|equal|season/i.test(message);
    return NextResponse.json(
      { error: isConflict ? '配賦内容が支出と一致しません。内容を確認してください。' : '商品原価データの保存に失敗しました。' },
      { status: isConflict ? 409 : 500 },
    );
  }
}
