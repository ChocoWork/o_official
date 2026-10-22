jest.mock('server-only', () => ({}), { virtual: true });

import { loadOrderStatusEmailUrl } from '@/lib/orders/status/status-email';
import { OrderStatusStoreError, type OrderStatusStore } from '@/lib/orders/status/status-store';

/**
 * 注文メールの「ご注文の状況はこちら」のURL（グループ E-5 計画 P12・C-2）。
 * トークンは試験用の作り物（43文字）。mock の store だけで流し、DB・ネットには触れない。
 */
const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const SITE = 'https://shop.example.test';

function makeStore(response: { data?: unknown; error?: unknown } | Error) {
  const rpc = jest.fn(async () => {
    if (response instanceof Error) throw response;
    return { data: response.data ?? null, error: response.error ?? null };
  });
  const from = jest.fn();
  return { store: { rpc, from } as unknown as OrderStatusStore, rpc, from };
}

function setSiteUrl(siteUrl: string | undefined) {
  jest.replaceProperty(process, 'env', siteUrl === undefined ? { NODE_ENV: 'test' } : { NODE_ENV: 'test', NEXT_PUBLIC_SITE_URL: siteUrl });
}

describe('loadOrderStatusEmailUrl', () => {
  let logs: jest.SpyInstance[];

  beforeEach(() => {
    setSiteUrl(SITE);
    logs = [jest.spyOn(console, 'error'), jest.spyOn(console, 'warn'), jest.spyOn(console, 'log')].map((spy) =>
      spy.mockImplementation(() => {}),
    );
  });
  afterEach(() => {
    // どの結果でも、トークン・URL・注文の番号をログに出さない
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('DBの関数でリンクを用意し、サイトの住所を基にした /order-status/{トークン} の絶対URLを返す', async () => {
    const { store, rpc, from } = makeStore({ data: TOKEN });

    await expect(loadOrderStatusEmailUrl(store, ORDER_ID)).resolves.toBe(`${SITE}/order-status/${TOKEN}`);

    // 既にリンクがある注文でも同じ呼び方で、同じトークンが返る（作り直さない）。直接の表の読み書きはしない
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('ensure_order_status_link', { _order_id: ORDER_ID });
    expect(from).not.toHaveBeenCalled();
  });

  it.each([
    ['末尾にスラッシュがある', `${SITE}/`, `${SITE}/order-status/${TOKEN}`],
    ['パスが付いている（先頭が / の道筋なので置き換わる）', `${SITE}/shop`, `${SITE}/order-status/${TOKEN}`],
    ['http の手元のサイト', 'http://localhost:3000', `http://localhost:3000/order-status/${TOKEN}`],
    ['http が無い設定は https を補う', 'shop.example.test', `${SITE}/order-status/${TOKEN}`],
  ])('サイトの住所の書き方: %s', async (_label, siteUrl, expected) => {
    setSiteUrl(siteUrl);
    const { store } = makeStore({ data: TOKEN });

    await expect(loadOrderStatusEmailUrl(store, ORDER_ID)).resolves.toBe(expected);
  });

  it('サイトの住所の設定が無ければ手元の既定の住所を使う', async () => {
    setSiteUrl(undefined);
    const { store } = makeStore({ data: TOKEN });

    await expect(loadOrderStatusEmailUrl(store, ORDER_ID)).resolves.toBe(`http://localhost:3000/order-status/${TOKEN}`);
  });

  it.each(['http://', 'https://[broken', 'http://bad host', 'httpx://shop.example.test'])(
    'サイトの住所 %s が壊れている・http でも https でもなければ、例外にせず null（材料不足）。無駄なリンクは作らない',
    async (siteUrl) => {
      setSiteUrl(siteUrl);
      const { store, rpc } = makeStore({ data: TOKEN });

      await expect(loadOrderStatusEmailUrl(store, ORDER_ID)).resolves.toBeNull();

      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it('DBの失敗は null にせず固定の store エラーを投げる（元のDBの文は cause にだけ残す）', async () => {
    const dbError = { message: `down ${TOKEN}`, code: '08006' };
    const { store } = makeStore({ error: dbError });

    const error = await loadOrderStatusEmailUrl(store, ORDER_ID).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(OrderStatusStoreError);
    expect(error).toMatchObject({ message: 'order status store failed', code: 'ORDER_STATUS_STORE_FAILED', operation: 'ensure_order_status_link' });
    expect((error as OrderStatusStoreError).cause).toBe(dbError);
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });

  it('rpc が例外を投げる場合も固定の store エラーにする', async () => {
    const { store } = makeStore(new Error('network down'));

    await expect(loadOrderStatusEmailUrl(store, ORDER_ID)).rejects.toBeInstanceOf(OrderStatusStoreError);
  });

  it.each([null, undefined, '', TOKEN.slice(0, 42), `${TOKEN}A`, `${TOKEN.slice(0, 42)}+`, { token: TOKEN }])(
    'DBが43文字のトークン以外（%j）を返したら、URLを作らず固定の store エラー',
    async (data) => {
      const { store } = makeStore({ data });

      await expect(loadOrderStatusEmailUrl(store, ORDER_ID)).rejects.toBeInstanceOf(OrderStatusStoreError);
    },
  );
});
