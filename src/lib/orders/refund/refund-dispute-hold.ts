import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * カード会社の判断待ち（支払いの取り消し）の注文を読む（会計の計画3 4-e3・preflight #17）。
 * DB は返金を ACCOUNTING_DISPUTE_HOLD で断るが、DETAIL は注文の数だけなので、窓口が get_order_dispute_holds を読み直して
 * 応答の orderIds を作る。読めなければ空にする（断りの応答は変えない）。DB の文・生の誤りはログにも出さず、失敗の名前だけ残す。
 * サーバーだけで使う。単体テストが直接読むので、サーバー専用の印（server-only）は付けない。
 */
export type DisputeHoldStore = Pick<SupabaseClient, 'rpc'>;

function uniqueOrderIds(data: unknown): string[] | null {
  if (!Array.isArray(data)) {
    return null;
  }
  const ids: string[] = [];
  for (const row of data) {
    const id = row !== null && typeof row === 'object' && 'order_id' in row ? row.order_id : undefined;
    if (typeof id !== 'string' || id.length === 0) {
      return null;
    }
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

/** 注文のうち判断待ちの取り消しがあるものの番号。読めない時は null（呼ぶ側が空・偽に直す） */
async function readHeldOrderIdsOrNull(store: DisputeHoldStore, orderIds: readonly string[]): Promise<string[] | null> {
  try {
    const { data, error } = await store.rpc('get_order_dispute_holds', { _order_ids: [...orderIds] });
    if (error) {
      console.error('[refund.dispute-hold] the holds were not read');
      return null;
    }
    const ids = uniqueOrderIds(data);
    if (ids === null) {
      console.error('[refund.dispute-hold] the holds had an unexpected shape');
    }
    return ids;
  } catch (error) {
    console.error('[refund.dispute-hold] the holds were not read', error instanceof Error ? error.name : 'UnknownError');
    return null;
  }
}

/** 断りの応答に添える、判断待ちの注文の番号。読めなければ空の配列 */
export async function readHeldOrderIds(store: DisputeHoldStore, orderIds: readonly string[]): Promise<string[]> {
  return (await readHeldOrderIdsOrNull(store, orderIds)) ?? [];
}

/** 返品の注文を引いて、判断待ちの注文の番号を読む。引けない・読めない時は空の配列 */
export async function readHeldOrderIdsOfReturn(
  store: DisputeHoldStore & Pick<SupabaseClient, 'from'>,
  returnId: string,
): Promise<string[]> {
  try {
    const { data, error } = await store.from('order_returns').select('order_id').eq('id', returnId).maybeSingle<{ order_id: string }>();
    if (error || !data || typeof data.order_id !== 'string') {
      console.error('[refund.dispute-hold] the return order was not read');
      return [];
    }
    return await readHeldOrderIds(store, [data.order_id]);
  } catch (error) {
    console.error('[refund.dispute-hold] the return order was not read', error instanceof Error ? error.name : 'UnknownError');
    return [];
  }
}

/**
 * 画面に出す「この注文は判断待ちか」。読めない時は偽にする: 画面の印は案内で、止めるのは DB（返金・受け取りの関数が断る）。
 * 読めなかったことはログに残る
 */
export async function hasDisputeHold(store: DisputeHoldStore, orderId: string): Promise<boolean> {
  return ((await readHeldOrderIdsOrNull(store, [orderId])) ?? []).length > 0;
}

/**
 * 答えの本文が DISPUTE_HOLD の断りなら、判断待ちの注文の番号を読み直して orderIds に入れる（ほかの答えは変えない）。
 * 本文が判断待ちの断りでなければ読まない（Stripe の断り・値段の計画の断り・0円の終わりなどは、この道を通らない）
 */
export async function withHeldOrderIds<T extends { body: unknown }>(reply: T, read: () => Promise<string[]>): Promise<T> {
  const { body } = reply;
  if (body === null || typeof body !== 'object' || !('code' in body) || body.code !== 'DISPUTE_HOLD') {
    return reply;
  }
  let orderIds: string[] = [];
  try {
    orderIds = await read();
  } catch (error) {
    console.error('[refund.dispute-hold] the holds were not read', error instanceof Error ? error.name : 'UnknownError');
  }
  return { ...reply, body: { ...body, orderIds } };
}
