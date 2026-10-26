import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { ORDER_STATUSES } from '@/lib/orders/order-payment-types';
import { countOrdersWithOpenCancelRequest, listOrderIdsWithOpenCancelRequest } from '@/lib/orders/returns/cancel-request-reads';
import { countReturnAttention } from '@/lib/orders/returns/return-store';
import { RETURN_DISPLAY_STATUSES, type ReturnDisplayStatus } from '@/lib/orders/returns/return-types';
import { buildAdminOrderSummaries, type AdminOrderSummaryInput as OrderRow } from '@/lib/orders/admin-orders/admin-order-summary';

const searchTextSchema = z.string().trim().min(1).max(200).optional();
const querySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    amountMin: z.coerce.number().int().nonnegative().optional(),
    amountMax: z.coerce.number().int().nonnegative().optional(),
    counterparty: searchTextSchema,
    reference: searchTextSchema,
    status: z.enum(ORDER_STATUSES).optional(),
    review: z.enum(['only']).optional(),
    // 返品の絞り込み（画面の返品の状態。DB の状態の絞り込み status とは別。グループ E-3 設計書 8-1）
    return: z.enum(RETURN_DISPLAY_STATUSES).optional(),
    // キャンセルの申し込みの絞り込み（開いている申し込みのある注文だけ。グループ E-3 段2）
    cancelRequest: z.enum(['open']).optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'from must be before or equal to to',
    path: ['from'],
  })
  .refine(
    (value) =>
      value.amountMin === undefined ||
      value.amountMax === undefined ||
      value.amountMin <= value.amountMax,
    { message: 'amountMin must be less than or equal to amountMax', path: ['amountMin'] },
  );

function escapePostgrestFilterValue(value: string): string {
  return value.replace(/[\\%_,()]/g, (character) => `\\${character}`);
}

async function fetchReturnAttention(): Promise<{ requested: number; refundWaiting: number }> {
  const { requested, refundWaiting } = await countReturnAttention(await createServiceRoleClient());
  return { requested, refundWaiting };
}

/**
 * 返品の絞り込み（return=）に当たる注文の番号。新しい注文から500件まで（DB の関数が切る）。service_role の RPC。
 * 返品の store の一覧に無い関数なので、ここで直に呼ぶ。読めなかった時は投げる（窓口が 500 にする）
 */
async function fetchOrderIdsByReturnStatus(displayStatus: ReturnDisplayStatus): Promise<string[]> {
  const { data, error } = await (await createServiceRoleClient()).rpc('list_order_ids_by_return_status', {
    _display_status: displayStatus,
  });
  if (error) {
    throw error;
  }
  return ((data ?? []) as Array<{ order_id: string }>).map((row) => row.order_id);
}

// 返品の絞り込みで、注文の番号を1回の問い合わせの URL に載せる数。番号は1件で39字（uuid と区切りの %2C）になる。
// 手元の Kong（nginx の8KB）は、この一覧の読む列と既定の絞り込みで、約196件から 414 を返した（2026-10-12 に実測。500件だと約20KB）。
// 検索の文字（日本語は1字で9字に増える）が長くても収まるよう、今の1ページ分の in（最大100件）と同じ数にする
const ORDER_IDS_PER_REQUEST = 100;

/** 一覧の上の一行の数（開いているキャンセルの申し込みのある注文の数。表を直に読む。グループ E-3 段2、決め事 P11） */
async function fetchCancelRequestAttention(): Promise<number> {
  return countOrdersWithOpenCancelRequest(await createServiceRoleClient());
}

/** 絞り込み cancelRequest=open に当たる注文の番号（申し込みの新しい順に500件まで）。読めなかった時は投げる（窓口が 500 にする） */
async function fetchOrderIdsWithOpenCancelRequest(): Promise<string[]> {
  return listOrderIdsWithOpenCancelRequest(await createServiceRoleClient());
}

/**
 * 返品の絞り込み（return=）とキャンセルの申し込みの絞り込み（cancelRequest=open）の、注文の番号をまとめる。
 * 付いていない側は絞らない（null）。両方付いた時は、両方に当たる注文だけ（return= 側の並びのまま）
 */
function narrowOrderIds(returnIds: string[] | null, cancelRequestIds: string[] | null): string[] | null {
  if (returnIds === null) {
    return cancelRequestIds;
  }
  if (cancelRequestIds === null) {
    return returnIds;
  }
  const wanted = new Set(cancelRequestIds);
  return returnIds.filter((id) => wanted.has(id));
}

/**
 * ログに出す例外の項目。名前と、あれば code・operation だけにする（発送の窓口と同じ決まり）。
 * ・Supabase の誤りは、Error ではない素のオブジェクトで、message・details・hint を直下に持つ（だから名前は UnknownError になる）
 * ・FulfillmentStoreError は、DB の生の誤り（details・hint 込み）を cause に持ち、Node は [cause] まで出す
 * どちらも、誤りそのものはログに渡さない
 */
function describeErrorForLog(error: unknown): [name: string, code: unknown, operation: unknown] {
  const { code = null, operation = null } = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown;
    operation?: unknown;
  };
  return [error instanceof Error ? error.name : 'UnknownError', code, operation];
}

export async function GET(request: Request) {
  try {
    const authz = await authorizeAdminPermission('admin.orders.read', request);
    if (!authz.ok) {
      return authz.response;
    }

    const requestUrl = new URL(request.url);
    const parsedQuery = querySchema.safeParse({
      page: requestUrl.searchParams.get('page') ?? undefined,
      pageSize: requestUrl.searchParams.get('pageSize') ?? undefined,
      from: requestUrl.searchParams.get('from') ?? undefined,
      to: requestUrl.searchParams.get('to') ?? undefined,
      amountMin: requestUrl.searchParams.get('amountMin') ?? undefined,
      amountMax: requestUrl.searchParams.get('amountMax') ?? undefined,
      counterparty: requestUrl.searchParams.get('counterparty') ?? undefined,
      reference: requestUrl.searchParams.get('reference') ?? undefined,
      status: requestUrl.searchParams.get('status') ?? undefined,
      review: requestUrl.searchParams.get('review') ?? undefined,
      return: requestUrl.searchParams.get('return') ?? undefined,
      cancelRequest: requestUrl.searchParams.get('cancelRequest') ?? undefined,
    });

    if (!parsedQuery.success) {
      return NextResponse.json(
        {
          error: 'Invalid query',
          details: parsedQuery.error.flatten(),
        },
        { status: 400 },
      );
    }

    const supabase = await createClient(request);
    const fromIso = parsedQuery.data.from ? `${parsedQuery.data.from}T00:00:00.000Z` : null;
    const toIso = parsedQuery.data.to ? `${parsedQuery.data.to}T23:59:59.999Z` : null;
    const page = parsedQuery.data.page;
    const pageSize = parsedQuery.data.pageSize;
    const offset = (page - 1) * pageSize;

    // 返品の絞り込み（return=）とキャンセルの申し込みの絞り込み（cancelRequest=open）。返品は DB の関数、申し込みは表が、当たる注文の番号（どちらも新しい物から500件まで）を返すので、その番号で注文を絞る。
    // 当たる注文が無ければ、注文を読まずに空の一覧を返す（in の中身が空の問い合わせを投げない）
    const returnIds = parsedQuery.data.return ? await fetchOrderIdsByReturnStatus(parsedQuery.data.return) : null;
    const cancelRequestIds = parsedQuery.data.cancelRequest ? await fetchOrderIdsWithOpenCancelRequest() : null;
    const listFilterOrderIds = narrowOrderIds(returnIds, cancelRequestIds);
    if (listFilterOrderIds !== null && listFilterOrderIds.length === 0) {
      return NextResponse.json(
        {
          data: [],
          pagination: { page, pageSize, total: 0, totalPages: 1 },
          returnAttention: await fetchReturnAttention(),
          cancelRequestAttention: await fetchCancelRequestAttention(),
        },
        { status: 200 },
      );
    }

    // 一覧の問い合わせ（読む列・絞り込み・並び）。問い合わせの入れ物は、絞り込みを足すと中身が変わって使い回せないので、
    // 返品の絞り込みで注文の番号を分けて何回か投げる時のために、呼ぶたびに作る
    const buildOrdersQuery = () => {
      let query = supabase
        .from('orders')
        .select(`
          id,
          payment_intent_id,
          checkout_session_id,
          review_reason,
          reviewed_at,
          status,
          total_amount,
          refunded_amount,
          currency,
          shipping_full_name,
          shipping_email,
          shipping_postal_code,
          shipping_prefecture,
          shipping_city,
          shipping_address,
          shipping_phone,
          created_at,
          shipped_at,
          shipping_carrier,
          tracking_number,
          order_items (
            id,
            item_name,
            color,
            size,
            quantity,
            fulfillment_type,
            line_kind
          )
        `, { count: 'exact' })
        .order('created_at', { ascending: false });

      if (fromIso) {
        query = query.gte('created_at', fromIso);
      }

      if (toIso) {
        query = query.lte('created_at', toIso);
      }

      if (parsedQuery.data.amountMin !== undefined) {
        query = query.gte('total_amount', parsedQuery.data.amountMin);
      }

      if (parsedQuery.data.amountMax !== undefined) {
        query = query.lte('total_amount', parsedQuery.data.amountMax);
      }

      if (parsedQuery.data.status) {
        query = query.eq('status', parsedQuery.data.status);
      } else {
        // 放棄（決済画面を開いたまま離れた注文）は既定の一覧に出さない。絞り込みで選べる（設計書 5-2）
        query = query.neq('status', 'abandoned');
      }

      if (parsedQuery.data.review === 'only') {
        query = query.not('review_reason', 'is', null).is('reviewed_at', null);
      }

      if (parsedQuery.data.counterparty) {
        const counterparty = escapePostgrestFilterValue(parsedQuery.data.counterparty);
        query = query.or(
          `shipping_full_name.ilike.%${counterparty}%,shipping_email.ilike.%${counterparty}%`,
        );
      }

      if (parsedQuery.data.reference) {
        const reference = escapePostgrestFilterValue(parsedQuery.data.reference);
        query = query.or(`id.ilike.%${reference}%,payment_intent_id.ilike.%${reference}%`);
      }

      return query;
    };

    let orderRows: OrderRow[];
    let total: number;
    if (listFilterOrderIds === null) {
      const { data, count, error } = await buildOrdersQuery().range(offset, offset + pageSize - 1);

      if (error) {
        console.error('[admin.orders] Failed to fetch orders:', ...describeErrorForLog(error));
        return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500 });
      }

      orderRows = (data ?? []) as OrderRow[];
      total = count ?? 0;
    } else {
      // 当たる注文の番号を1回の URL に全部載せると、500件で約20KB になり 414 で断られる（手元の Kong は約196件から）。
      // 100件ずつ、ほかの絞り込みを重ねて読み（多くて5回・500件。DB の関数が新しい注文から500件で切る）、
      // 新しい順に並べ直してから、このページの分を切り出す。総数は当たった数
      const matched: OrderRow[] = [];
      for (let start = 0; start < listFilterOrderIds.length; start += ORDER_IDS_PER_REQUEST) {
        const { data, error } = await buildOrdersQuery().in('id', listFilterOrderIds.slice(start, start + ORDER_IDS_PER_REQUEST));

        if (error) {
          console.error('[admin.orders] Failed to fetch orders:', ...describeErrorForLog(error));
          return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500 });
        }

        matched.push(...((data ?? []) as OrderRow[]));
      }
      matched.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      orderRows = matched.slice(offset, offset + pageSize);
      total = matched.length;
    }
    const [responseData, returnAttention, cancelRequestAttention] = await Promise.all([
      createServiceRoleClient().then((store) => buildAdminOrderSummaries(store, orderRows)),
      fetchReturnAttention(),
      fetchCancelRequestAttention(),
    ]);

    const totalPages = total === 0 ? 1 : Math.ceil(total / pageSize);

    return NextResponse.json(
      {
        data: responseData,
        pagination: {
          page,
          pageSize,
          total,
          totalPages,
        },
        returnAttention,
        cancelRequestAttention,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('GET /api/admin/orders error:', ...describeErrorForLog(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
