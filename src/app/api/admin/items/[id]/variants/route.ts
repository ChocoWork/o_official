import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { authorizeAdminPermission, authorizeAdminPermissions } from '@/lib/auth/admin-rbac';
import { logAudit } from '@/lib/audit';
import { toOrderNumber } from '@/lib/orders/order-number';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { listGroupGVariantInventory, listItemAllocationHistory, recordStockMovement, StockMovementError } from '@/lib/inventory/allocation-store';
import { formatReturnNumber } from '@/lib/orders/returns/return-messages';

/**
 * 色 × サイズ（バリアント）の在庫を管理画面から扱う（FREQ-399）。
 *
 * 在庫は台帳（stock_movements）への追記でしか動かさない。ここでも直接 item_variants を
 * 更新しない（DB 側もトリガーで追記以外を拒む）。
 */

const itemIdSchema = z.coerce.number().int().positive().safe();

// 注文の処理が書く理由（purchase / cancel / refund / return / exchange）は管理画面から打てない。
// 打てると「注文に紐づかない購入」が台帳に混ざり、受注数や突合の意味が壊れる。
// return（返品の受け取り）と exchange（交換の品の確保）は、返品の DB の関数だけが書く（グループ E-3）。
const ADMIN_STOCK_REASONS = ['restock', 'adjustment'] as const;

const movementSchema = z.object({
  variantId: z.coerce.number().int().positive().safe(),
  // delta <> 0 は DB 側の CHECK にもあるが、理由の分かる 400 で先に断る。
  delta: z.coerce.number().int().min(-2147483648).max(2147483647).refine((value) => value !== 0, '増減は 0 以外'),
  reason: z.enum(ADMIN_STOCK_REASONS),
  note: z.string().trim().max(200).optional(),
  requestKey: z.string().uuid(),
  expectedReleaseQuantity: z.number().int().min(0).max(2147483647).optional(),
});

type VariantRow = {
  id: number;
  is_active: boolean;
  sku: string | null;
  item_colors: { name: string; hex: string; position: number } | null;
  item_sizes: { label: string; position: number } | null;
};

/** public.list_item_stock_history の1行（設計書 10-2） */
type StockHistoryRow = {
  movement_id: number;
  variant_id: number;
  delta: number;
  reason: string;
  note: string | null;
  created_at: string;
  actor_email: string | null;
  order_id: string | null;
  balance_after: number;
  /** 返金で動いた行の返金の番号。返金に結び付かない行は null */
  refund_id: string | null;
  /** 返品の受け取り（return）と交換の品の確保（exchange）で動いた行の返品の番号。返品に結び付かない行は null */
  return_id: string | null;
};

/** 在庫の履歴の返品で動いた行の、返品の番号の文字を作る材料（public.order_returns。service_role は SELECT だけを持つ） */
type StockHistoryReturnRow = { id: string; order_id: string; number: number };

/** 在庫の画面に出す履歴の件数 */
const STOCK_HISTORY_LIMIT = 50;

/**
 * ログに出す誤りの項目。名前と、あれば code だけにする（src/app/api/admin/orders/route.ts の describeErrorForLog と同じ考え）。
 * PostgREST の誤りは message・details・hint に DB の文（引数や行の値）を持つので、誤りそのものはログに渡さない。
 */
function describeErrorForLog(error: unknown): [name: string, code: unknown] {
  const { code = null } = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown };
  return [error instanceof Error ? error.name : 'UnknownError', code];
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const authz = await authorizeAdminPermission('admin.stock.read', request);
    if (!authz.ok) {
      return authz.response;
    }

    const { id } = await params;
    const parsedItemId = itemIdSchema.safeParse(id);
    if (!parsedItemId.success) {
      return NextResponse.json({ error: 'Invalid item id' }, { status: 400 });
    }
    const itemId = parsedItemId.data;

    const supabase = await createServiceRoleClient();

    // 商品の色・サイズは items.colors / items.sizes にも入っている。読む前にそろえないと、
    // 管理画面で色を足した直後に在庫を入れる先が無い。この関数は冪等（ON CONFLICT DO NOTHING）。
    const { error: syncError } = await supabase.rpc('backfill_item_variants', {
      target_item_id: itemId,
    });
    if (syncError) {
      console.error('Failed to sync item variants:', itemId, ...describeErrorForLog(syncError));
      return NextResponse.json({ error: 'Failed to sync item variants' }, { status: 500 });
    }

    const { data: variants, error: variantsError } = await supabase
      .from('item_variants')
      .select('id, is_active, sku, item_colors(name, hex, position), item_sizes(label, position)')
      .eq('item_id', itemId)
      .order('id', { ascending: true });

    if (variantsError) {
      console.error('Failed to fetch item variants:', itemId, ...describeErrorForLog(variantsError));
      return NextResponse.json({ error: 'Failed to fetch item variants' }, { status: 500 });
    }

    const variantRows = (variants ?? []) as unknown as VariantRow[];
    const variantIds = variantRows.map((row) => row.id);

    // 引き当て済みと受注生産の数は DB の関数が1か所で数える。台帳や view を画面の側で数え直さない。
    // 読めなかった時に 0 と見せると製造と仕入れの判断を誤るので、失敗は隠さない
    let stockStates;
    try {
      stockStates = await listGroupGVariantInventory(supabase, variantIds);
    } catch (error) {
      console.error('Failed to fetch variant stock states:', itemId, ...describeErrorForLog(error));
      return NextResponse.json({ error: 'Failed to fetch variant stock states' }, { status: 500 });
    }
    const allocationEvents = variantIds.length ? await listItemAllocationHistory(supabase, itemId, STOCK_HISTORY_LIMIT) : [];

    const { data: history, error: historyError } = variantIds.length
      ? await supabase.rpc('list_item_stock_history', { _item_id: itemId, _limit: STOCK_HISTORY_LIMIT })
      : { data: [], error: null };
    if (historyError) {
      console.error('Failed to fetch stock history:', itemId, ...describeErrorForLog(historyError));
      return NextResponse.json({ error: 'Failed to fetch stock history' }, { status: 500 });
    }

    // 返品の受け取り・交換の品の確保で動いた行は、どの返品かを返品の番号（{注文番号}-R{n}。設計書 8-1「どの注文のどの返品か」）で返す。
    // 番号の文字は DB が作らないので、履歴に出た返品だけを返品の表から読み、注文の番号と何番目かから付ける
    const historyRows = (history ?? []) as StockHistoryRow[];
    const returnIds = [...new Set(historyRows.flatMap((row) => (row.return_id ? [row.return_id] : [])))];
    const { data: returnRows, error: returnRowsError } = returnIds.length
      ? await supabase.from('order_returns').select('id, order_id, number').in('id', returnIds)
      : { data: [], error: null };
    if (returnRowsError) {
      console.error('Failed to fetch stock history returns:', itemId, ...describeErrorForLog(returnRowsError));
      return NextResponse.json({ error: 'Failed to fetch stock history' }, { status: 500 });
    }
    const returnNumberById = new Map(
      ((returnRows ?? []) as StockHistoryReturnRow[]).map((row) => [row.id, formatReturnNumber(row.order_id, row.number)] as const),
    );

    const stateByVariant = new Map(stockStates.map((row) => [row.variant_id, row]));

    return NextResponse.json(
      {
        variants: variantRows.map((row) => {
          const state = stateByVariant.get(row.id);
          if (!state) throw new Error('INVENTORY_READ_FAILED');
          const committedQuantity = state.paid_allocated + state.payment_held;

          return {
            id: row.id,
            colorName: row.item_colors?.name ?? null,
            colorHex: row.item_colors?.hex ?? null,
            sizeLabel: row.item_sizes?.label ?? null,
            sku: row.sku,
            stockQuantity: state.free,
            isActive: row.is_active,
            committedQuantity,
            // 手元の数は棚に実際にある数。すぐ出せる数に、注文のために取ってある数を足す（設計書 10-1）
            onHandQuantity: state.on_hand,
            backorderQuantity: state.waiting,
          };
        }),
        allocationEvents,
        movements: historyRows.map((row) => ({
          id: row.movement_id,
          variantId: row.variant_id,
          delta: row.delta,
          reason: row.reason,
          note: row.note,
          createdAt: row.created_at,
          actorEmail: row.actor_email,
          orderId: row.order_id,
          orderNumber: row.order_id ? toOrderNumber(row.order_id) : null,
          balanceAfter: row.balance_after,
          refundId: row.refund_id,
          returnId: row.return_id,
          // 返品で動いた行は、どの返品かを番号で出す（設計書 8-1）。返品に結び付かない行は null
          returnNumber: row.return_id ? (returnNumberById.get(row.return_id) ?? null) : null,
        })),
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('GET /api/admin/items/:id/variants error:', ...describeErrorForLog(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    // 在庫の入荷・棚卸は stock.manage に加えて stock.read も要る（DB の関数 admin_record_stock_movement も同じ組を確かめる）
    const authz = await authorizeAdminPermissions(['admin.stock.manage', 'admin.stock.read'], request);
    if (!authz.ok) {
      return authz.response;
    }

    const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
    const csrfResult = await requireCsrfOrDeny();
    if (csrfResult instanceof Response) return csrfResult;
    const rate = { endpoint: 'admin.items.stock.move', limit: 50, windowSeconds: 600 };
    const ipLimited = await enforceRateLimit({ request, ...rate });
    if (ipLimited) return ipLimited;
    const actorLimited = await enforceRateLimit({ request, ...rate, subject: authz.userId });
    if (actorLimited) return actorLimited;

    const { id } = await params;
    const parsedItemId = itemIdSchema.safeParse(id);
    if (!parsedItemId.success) {
      return NextResponse.json({ error: 'Invalid item id' }, { status: 400 });
    }
    const itemId = parsedItemId.data;

    const parsed = movementSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { variantId, delta, reason, note, requestKey, expectedReleaseQuantity } = parsed.data;
    const supabase = await createServiceRoleClient();
    const audit = (outcome: 'success' | 'failure' | 'error', metadata: Record<string, unknown>) => logAudit({
      action: 'admin.items.stock.move', actor_id: authz.userId, resource: 'item_variants',
      resource_id: String(variantId), outcome, metadata: { item_id: itemId, delta, reason, ...metadata },
    });
    try {
      const result = await recordStockMovement(supabase, authz.userId, { itemId, variantId, delta, reason,
        note: note ?? null, requestKey, expectedReleaseQuantity: expectedReleaseQuantity ?? null });
      await audit('success', { movement_id: result.movementId, released_quantity: result.releasedQuantity,
        allocated_quantity: result.allocatedQuantity, replayed: result.replayed });
      return NextResponse.json({ success: true }, { status: 201 });
    } catch (error) {
      const failure = error instanceof StockMovementError ? error : new StockMovementError();
      await audit(failure.code ? 'failure' : 'error', { code: failure.code ?? 'STOCK_MOVEMENT_FAILED' });
      return NextResponse.json({ ...(failure.code ? { code: failure.code } : {}), error: failure.message,
        ...(failure.releasedQuantity !== undefined ? { releasedQuantity: failure.releasedQuantity } : {}) },
      { status: failure.status });
    }
  } catch (error) {
    // 名前と code だけを残す（message・details は出さない）
    console.error('POST /api/admin/items/:id/variants error:', ...describeErrorForLog(error));
    return NextResponse.json({ error: '在庫の記録に失敗しました' }, { status: 500 });
  }
}
