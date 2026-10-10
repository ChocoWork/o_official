import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { logAudit } from '@/lib/audit';
import { toOrderNumber } from '@/lib/orders/order-number';

/**
 * 色 × サイズ（バリアント）の在庫を管理画面から扱う（FREQ-399）。
 *
 * 在庫は台帳（stock_movements）への追記でしか動かさない。ここでも直接 item_variants を
 * 更新しない（DB 側もトリガーで追記以外を拒む）。
 */

const itemIdSchema = z.coerce.number().int().positive();

// 注文の処理が書く理由（purchase / cancel / refund）は管理画面から打てない。
// 打てると「注文に紐づかない購入」が台帳に混ざり、受注数や突合の意味が壊れる。
const ADMIN_STOCK_REASONS = ['restock', 'adjustment'] as const;

const movementSchema = z.object({
  variantId: z.coerce.number().int().positive(),
  // delta <> 0 は DB 側の CHECK にもあるが、理由の分かる 400 で先に断る。
  delta: z.coerce.number().int().refine((value) => value !== 0, '増減は 0 以外'),
  reason: z.enum(ADMIN_STOCK_REASONS),
  note: z.string().trim().max(200).optional(),
});

/** 在庫が 0 を下回る追記は CHECK 制約で弾かれる。 */
const CHECK_VIOLATION = '23514';

type VariantRow = {
  id: number;
  stock_quantity: number;
  is_active: boolean;
  sku: string | null;
  item_colors: { name: string; hex: string; position: number } | null;
  item_sizes: { label: string; position: number } | null;
};

/** public.list_variant_stock_states の1行（引き当て済みと受注生産の数。設計書 10-1） */
type StockStateRow = {
  variant_id: number;
  committed: number;
  backorder: number;
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
};

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
    const authz = await authorizeAdminPermission('admin.items.read', request);
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
      console.error('Failed to sync item variants:', itemId, syncError);
      return NextResponse.json({ error: 'Failed to sync item variants' }, { status: 500 });
    }

    const { data: variants, error: variantsError } = await supabase
      .from('item_variants')
      .select('id, stock_quantity, is_active, sku, item_colors(name, hex, position), item_sizes(label, position)')
      .eq('item_id', itemId)
      .order('id', { ascending: true });

    if (variantsError) {
      console.error('Failed to fetch item variants:', itemId, variantsError);
      return NextResponse.json({ error: 'Failed to fetch item variants' }, { status: 500 });
    }

    const variantRows = (variants ?? []) as unknown as VariantRow[];
    const variantIds = variantRows.map((row) => row.id);

    // 引き当て済みと受注生産の数は DB の関数が1か所で数える。台帳や view を画面の側で数え直さない。
    // 読めなかった時に 0 と見せると製造と仕入れの判断を誤るので、失敗は隠さない
    const { data: stockStates, error: stockStatesError } = variantIds.length
      ? await supabase.rpc('list_variant_stock_states', { _variant_ids: variantIds })
      : { data: [], error: null };
    if (stockStatesError) {
      console.error('Failed to fetch variant stock states:', itemId, ...describeErrorForLog(stockStatesError));
      return NextResponse.json({ error: 'Failed to fetch variant stock states' }, { status: 500 });
    }

    const { data: history, error: historyError } = variantIds.length
      ? await supabase.rpc('list_item_stock_history', { _item_id: itemId, _limit: STOCK_HISTORY_LIMIT })
      : { data: [], error: null };
    if (historyError) {
      console.error('Failed to fetch stock history:', itemId, ...describeErrorForLog(historyError));
      return NextResponse.json({ error: 'Failed to fetch stock history' }, { status: 500 });
    }

    const stateByVariant = new Map<number, StockStateRow>(
      ((stockStates ?? []) as StockStateRow[]).map((row) => [row.variant_id, row]),
    );

    return NextResponse.json(
      {
        variants: variantRows.map((row) => {
          const state = stateByVariant.get(row.id);
          const committedQuantity = state?.committed ?? 0;

          return {
            id: row.id,
            colorName: row.item_colors?.name ?? null,
            colorHex: row.item_colors?.hex ?? null,
            sizeLabel: row.item_sizes?.label ?? null,
            sku: row.sku,
            stockQuantity: row.stock_quantity,
            isActive: row.is_active,
            committedQuantity,
            // 手元の数は棚に実際にある数。すぐ出せる数に、注文のために取ってある数を足す（設計書 10-1）
            onHandQuantity: row.stock_quantity + committedQuantity,
            backorderQuantity: state?.backorder ?? 0,
          };
        }),
        movements: ((history ?? []) as StockHistoryRow[]).map((row) => ({
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
        })),
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('GET /api/admin/items/:id/variants error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const authz = await authorizeAdminPermission('admin.items.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

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

    const { variantId, delta, reason, note } = parsed.data;
    const supabase = await createServiceRoleClient();

    // 別の商品のバリアントに在庫を入れられないよう、item_id と合わせて引く（BOLA 対策）。
    const { data: variant, error: variantError } = await supabase
      .from('item_variants')
      .select('id')
      .eq('id', variantId)
      .eq('item_id', itemId)
      .maybeSingle<{ id: number }>();

    if (variantError) {
      console.error('Failed to look up item variant:', variantId, variantError);
      return NextResponse.json({ error: 'Failed to record stock movement' }, { status: 500 });
    }

    if (!variant) {
      return NextResponse.json({ error: 'Variant not found' }, { status: 404 });
    }

    const { error: insertError } = await supabase.from('stock_movements').insert({
      variant_id: variantId,
      delta,
      reason,
      note: note ?? null,
      created_by: authz.userId,
    });

    if (insertError) {
      // 在庫が 0 を下回る引き落とし。操作の誤りなので、理由の分かる 409 で返す。
      if (insertError.code === CHECK_VIOLATION) {
        await logAudit({
          action: 'admin.items.stock.move',
          actor_id: authz.userId,
          resource: 'item_variants',
          resource_id: String(variantId),
          outcome: 'failure',
          detail: 'Stock would go below zero',
          metadata: { item_id: itemId, delta, reason },
        });
        return NextResponse.json(
          { error: '在庫が足りないため、この数量は引けません。' },
          { status: 409 },
        );
      }

      console.error('Failed to insert stock movement:', variantId, insertError);
      await logAudit({
        action: 'admin.items.stock.move',
        actor_id: authz.userId,
        resource: 'item_variants',
        resource_id: String(variantId),
        outcome: 'error',
        detail: 'Failed to record stock movement',
        metadata: { item_id: itemId, delta, reason, error_message: insertError.message ?? null },
      });
      return NextResponse.json({ error: 'Failed to record stock movement' }, { status: 500 });
    }

    await logAudit({
      action: 'admin.items.stock.move',
      actor_id: authz.userId,
      resource: 'item_variants',
      resource_id: String(variantId),
      outcome: 'success',
      detail: `Stock moved by ${delta} (${reason})`,
      metadata: { item_id: itemId, delta, reason },
    });

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    console.error('POST /api/admin/items/:id/variants error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
