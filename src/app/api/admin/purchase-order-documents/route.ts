import 'server-only';

import { NextResponse } from 'next/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { searchPurchaseOrderDocuments } from '@/lib/purchase-orders/purchase-order-documents';
import { PurchaseOrderError } from '@/lib/purchase-orders/purchase-order-store';
import {
  isPurchaseOrderDay,
  PURCHASE_ORDER_DOCUMENT_PAGE_LIMIT,
  PURCHASE_ORDER_DOCUMENT_TEXT,
  PURCHASE_ORDER_LIMITS,
  type PurchaseOrderDocumentSearchFilters,
} from '@/lib/purchase-orders/purchase-order-types';
import { createServiceRoleClient } from '@/lib/supabase/server';

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

const PAGE = { min: 1, max: 100000 } as const;
const NUMBER_MAX_LENGTH = 20;

/** 空の条件は「かけない」（null）。値があれば前後の空白を落とす */
function readText(value: string | null): string | null {
  const text = value?.trim() ?? '';
  return text === '' ? null : text;
}

/** 日付の条件。空は null、実在の YYYY-MM-DD でなければ false（400） */
function readDay(value: string | null): string | null | false {
  const text = readText(value);
  if (text === null) return null;
  return isPurchaseOrderDay(text) ? text : false;
}

/** 金額（整数円）の条件。空は null、桁を絞った10進の整数で範囲内でなければ false（400） */
function readAmount(value: string | null): number | null | false {
  const text = readText(value);
  if (text === null) return null;
  if (!/^[0-9]{1,11}$/.test(text)) return false;
  const amount = Number(text);
  return amount <= PURCHASE_ORDER_LIMITS.documentAmountYen.max ? amount : false;
}

/** 条件を検査した値にする。1つでも合わなければ null（400） */
function readFilters(params: URLSearchParams): { filters: PurchaseOrderDocumentSearchFilters; page: number } | null {
  const dateFrom = readDay(params.get('dateFrom'));
  const dateTo = readDay(params.get('dateTo'));
  const amountMin = readAmount(params.get('amountMin'));
  const amountMax = readAmount(params.get('amountMax'));
  const counterparty = readText(params.get('counterparty'));
  const number = readText(params.get('number'));
  const kind = readText(params.get('kind'));
  const includeHistory = readText(params.get('includeHistory'));
  const pageText = params.get('page');
  if (dateFrom === false || dateTo === false || amountMin === false || amountMax === false) return null;
  if (counterparty !== null && counterparty.length > PURCHASE_ORDER_LIMITS.counterparty.max) return null;
  if (number !== null && number.length > NUMBER_MAX_LENGTH) return null;
  if (kind !== null && kind !== 'quote' && kind !== 'invoice') return null;
  if (includeHistory !== null && includeHistory !== '1' && includeHistory !== '0') return null;
  let page = 1;
  if (pageText !== null) {
    if (!/^[0-9]{1,7}$/.test(pageText)) return null;
    page = Number(pageText);
    if (page < PAGE.min || page > PAGE.max) return null;
  }
  return {
    filters: { dateFrom, dateTo, amountMin, amountMax, counterparty, number, kind, includeHistory: includeHistory === '1' },
    page,
  };
}

/**
 * 取引書類の検索（G-2 / FREQ-530）。取引日・金額の範囲、取引先の部分一致（大小文字を区別しない）、発注書番号の前方一致、種類を
 * AND で絞る。既定は各書類の最新の版だけで、includeHistory=1 なら訂正前の版も探す（isCurrent が偽の行）。1頁50件。
 * 読むだけで、保存先の鍵は返さない。権限は admin.purchase_orders.read で、窓口と DB の関数の両方で確かめる
 * （実行者は認可結果の userId だけから渡す）。回数制限と監査は無い。DB の生の誤りは本文にもログにも出さない。
 */
export async function GET(request: Request): Promise<Response> {
  const authz = await authorizeAdminPermission('admin.purchase_orders.read', request);
  if (!authz.ok) return noStore(authz.response);

  const input = readFilters(new URL(request.url).searchParams);
  if (input === null) return noStore(NextResponse.json({ error: 'Invalid request' }, { status: 400 }));

  try {
    const client = await createServiceRoleClient();
    const { rows, total } = await searchPurchaseOrderDocuments(client, authz.userId, input);
    return noStore(NextResponse.json({ rows, total, page: input.page, limit: PURCHASE_ORDER_DOCUMENT_PAGE_LIMIT }));
  } catch (error) {
    if (error instanceof PurchaseOrderError && error.code) {
      return noStore(NextResponse.json({ code: error.code, error: error.message }, { status: error.status }));
    }
    console.error('[admin.purchase_orders] document search failed');
    return noStore(NextResponse.json({ error: PURCHASE_ORDER_DOCUMENT_TEXT.searchApiFailed }, { status: 500 }));
  }
}
