import { act, renderHook, waitFor } from '@testing-library/react';
import { useOrderAttention } from '@/hooks/useOrderAttention';

/**
 * 旧 admin/page.tsx の要対応・要確認の操作の期待を、hook に移してもそのまま確かめる（G-4 Task 7 / FREQ-539-AC-05）。
 * 成功で欄と一覧（onChanged）を読み直す・403/503/429/通信切れの文・操作中の id。
 */
const mockFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockFetch(...args) }));

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const ATTENTION_URL = '/api/admin/order-attention';

function ok(body: unknown = {}): Promise<unknown> {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}
function refused(status: number, body: unknown = {}): Promise<unknown> {
  return Promise.resolve({ ok: false, status, json: async () => body });
}
const attentionBody = (reviews: unknown[] = []) => ({ data: { exceptions: [], reviews, counts: { exceptions: 0, reviews: reviews.length } } });

let postAnswer: (url: string) => Promise<unknown>;
let attentionAnswer: () => Promise<unknown>;

beforeEach(() => {
  mockFetch.mockReset();
  postAnswer = () => ok();
  attentionAnswer = () => ok(attentionBody());
  mockFetch.mockImplementation((url: string, init?: RequestInit) => (String(url) === ATTENTION_URL && init?.method !== 'POST' ? attentionAnswer() : postAnswer(String(url))));
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const attentionReads = () => mockFetch.mock.calls.filter(([url]) => String(url) === ATTENTION_URL).length;

/** 操作を始め、返事を受けて終わる（操作中の id が外れる）まで待つ */
async function trigger(result: { current: ReturnType<typeof useOrderAttention> }, run: () => void): Promise<void> {
  await act(async () => {
    run();
  });
  await waitFor(() => expect(result.current.processingIds).toEqual([]));
}

describe('useOrderAttention: 読み込み', () => {
  it('FREQ-539-AC-05: enabled の時だけ要対応を読み、読んだ欄を返す', async () => {
    attentionAnswer = () => ok(attentionBody([{ orderId: ORDER_ID }]));
    const { result, rerender } = renderHook(({ enabled }) => useOrderAttention({ enabled }), { initialProps: { enabled: false } });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.attention).toBeNull();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.attention?.counts.reviews).toBe(1));
    expect(mockFetch).toHaveBeenCalledWith(ATTENTION_URL, { cache: 'no-store' });
    expect(result.current.errorBanner).toBeNull();
    expect(result.current.errorMessage).toBeNull();
  });

  it.each([
    ['窓口が失敗', () => refused(500)],
    ['形が違う答え', () => ok({ data: { exceptions: [] } })],
    ['通信の失敗', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('FREQ-539-AC-05: 読めない時（%s）は、欄を出さずに「読み込めませんでした」を返す。「未処理なし」には見せない', async (_label, answer) => {
    attentionAnswer = answer;
    const { result } = renderHook(() => useOrderAttention({ enabled: true }));

    await waitFor(() => expect(result.current.errorBanner).toBe('要対応・要確認を読み込めませんでした。'));
    expect(result.current.attention).toBeNull();
  });

  it('FREQ-539-AC-05: reload で読み直すと、読めなかった表示は消える', async () => {
    attentionAnswer = () => refused(500);
    const { result } = renderHook(() => useOrderAttention({ enabled: true }));
    await waitFor(() => expect(result.current.errorBanner).not.toBeNull());

    attentionAnswer = () => ok(attentionBody());
    await act(async () => result.current.reload());

    expect(result.current.errorBanner).toBeNull();
    expect(result.current.attention).not.toBeNull();
  });
});

describe('useOrderAttention: 操作', () => {
  async function ready(onChanged?: () => void) {
    const hook = renderHook(() => useOrderAttention({ enabled: true, onChanged }));
    await waitFor(() => expect(hook.result.current.attention).not.toBeNull());
    return hook;
  }

  it('FREQ-539-AC-05: 要確認の「確認済みにする」は POST し、知らせを出し、欄と onChanged を読み直す', async () => {
    const onChanged = jest.fn();
    const { result } = await ready(onChanged);
    const before = attentionReads();

    await trigger(result, () => result.current.onReview(ORDER_ID));

    expect(mockFetch).toHaveBeenCalledWith(`/api/admin/orders/${ORDER_ID}/review`, { method: 'POST' });
    expect(result.current.noticeMessage).toBe('確認済みにしました。');
    expect(attentionReads()).toBe(before + 1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(result.current.processingIds).toEqual([]);
    expect(result.current.errorMessage).toBeNull();
  });

  it('FREQ-539-AC-05: 操作中は id を操作中に置き、終わると外す', async () => {
    const { result } = await ready();
    let release: (answer: unknown) => void = () => {};
    postAnswer = () => new Promise((resolve) => { release = resolve; });

    act(() => result.current.onReview(ORDER_ID));
    expect(result.current.processingIds).toEqual([ORDER_ID]);

    await act(async () => release({ ok: true, status: 200, json: async () => ({}) }));
    await waitFor(() => expect(result.current.processingIds).toEqual([]));
  });

  it.each([
    ['メモあり', 'メモ', { note: 'メモ' }],
    ['メモなし', '', {}],
  ])('FREQ-539-AC-05: 支払いの要対応を解決する（%s）は、空のメモを送らない', async (_label, note, expected) => {
    const { result } = await ready();

    await trigger(result, () => result.current.onResolve({ exceptionId: 'exception-1', note }));

    expect(mockFetch).toHaveBeenCalledWith('/api/admin/payment-exceptions/exception-1/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(expected),
    });
    expect(result.current.noticeMessage).toBe('解決済みにしました。');
  });

  it('FREQ-539-AC-05: 「注文を取り消して解決」は取消の理由と通知の有無を一緒に送る', async () => {
    const { result } = await ready();

    await trigger(result, () => result.current.onCancelAndResolve({
      exceptionId: 'exception-2',
      values: { reason: 'customer_request', note: '対応メモ', notifyCustomer: true },
    }));

    expect(mockFetch).toHaveBeenCalledWith('/api/admin/payment-exceptions/exception-2/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: '対応メモ', cancelOrder: true, cancelReason: 'customer_request', notifyCustomer: true }),
    });
    expect(result.current.noticeMessage).toBe('注文を取り消して解決しました。');
  });

  it('FREQ-539-AC-05: 配送の「対応済みにする」は空の本文を送り、知らせを出して、欄と onChanged を読み直す', async () => {
    const onChanged = jest.fn();
    const { result } = await ready(onChanged);
    const before = attentionReads();

    await trigger(result, () => result.current.onResolveDelivery('delivery-1'));

    expect(mockFetch).toHaveBeenCalledWith('/api/admin/order-attention/deliveries/delivery-1/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(result.current.noticeMessage).toBe('対応済みにしました。');
    expect(attentionReads()).toBe(before + 1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('FREQ-539-AC-05: 返事を待つ間に onChanged の関数が替わっても、返事の後は今の関数を呼ぶ', async () => {
    const first = jest.fn();
    const second = jest.fn();
    const { result, rerender } = renderHook(({ onChanged }) => useOrderAttention({ enabled: true, onChanged }), { initialProps: { onChanged: first } });
    await waitFor(() => expect(result.current.attention).not.toBeNull());
    let release: (answer: unknown) => void = () => {};
    postAnswer = () => new Promise((resolve) => { release = resolve; });

    act(() => result.current.onReview(ORDER_ID));
    rerender({ onChanged: second });
    await act(async () => release({ ok: true, status: 200, json: async () => ({}) }));

    await waitFor(() => expect(second).toHaveBeenCalledTimes(1));
    expect(first).not.toHaveBeenCalled();
  });

  it.each([
    ['403', () => refused(403, { error: 'Forbidden' }), 'この操作の権限がありません。'],
    ['503', () => refused(503), 'Stripe の状態を確認できませんでした。時間をおいて再試行してください。'],
    ['400 の日本語の文', () => refused(400, { error: '入力を確かめてください。' }), '入力を確かめてください。'],
    ['404（要確認は日本語の文を読まない）', () => refused(404, { error: '見つかりません。' }), '操作に失敗しました。一覧を更新してください。'],
    ['500', () => refused(500, { error: '内部の文' }), '操作に失敗しました。一覧を更新してください。'],
    ['通信が切れた', () => Promise.reject(new TypeError('Failed to fetch')), '通信できませんでした。一覧を更新してください。'],
  ])('FREQ-539-AC-05: 要確認の操作が %s の時は、理由を返し、知らせと onChanged を出さず、操作中を外す', async (_label, answer, message) => {
    const onChanged = jest.fn();
    const { result } = await ready(onChanged);
    postAnswer = answer;
    const before = attentionReads();

    await trigger(result, () => result.current.onReview(ORDER_ID));

    expect(result.current.errorMessage).toBe(message);
    expect(result.current.errorMessage).not.toBe('Failed to fetch');
    expect(result.current.noticeMessage).toBeNull();
    expect(result.current.processingIds).toEqual([]);
    expect(onChanged).not.toHaveBeenCalled();
    expect(attentionReads()).toBe(before);
    expect(console.error).toHaveBeenCalledWith('Failed to update order attention:', expect.any(Error));
  });

  it.each([
    [404, { error: '配送の要対応が見つかりません。' }, '配送の要対応が見つかりません。'],
    [409, { error: '操作の内容が変わりました。画面を開き直してください。' }, '操作の内容が変わりました。画面を開き直してください。'],
    [429, { error: 'Too many requests' }, 'しばらくしてから、もう一度お試しください。'],
    [500, { error: '配送の記録を保存できませんでした。' }, '操作に失敗しました。一覧を更新してください。'],
  ])('FREQ-539-AC-05: 配送の「対応済みにする」が %i で断られたら、日本語の文か画面の案内を返し、英語の文は返さない', async (status, body, message) => {
    const { result } = await ready();
    postAnswer = () => refused(status, body);

    await trigger(result, () => result.current.onResolveDelivery('delivery-1'));

    expect(result.current.errorMessage).toBe(message);
    expect(result.current.processingIds).toEqual([]);
  });

  it.each([503, 429])('FREQ-539-AC-05: %i の断りは本文を使わなくても読み切る（no-store の応答を開いたまま残さない）', async (status) => {
    const { result } = await ready();
    const arrayBuffer = jest.fn().mockResolvedValue(new ArrayBuffer(0));
    postAnswer = () => Promise.resolve({ ok: false, status, json: async () => ({}), arrayBuffer });

    // 429 の専用の文を持つのは配送の「対応済みにする」。503 は要確認の操作でも同じ枝を通る
    await trigger(result, () => (status === 429 ? result.current.onResolveDelivery('delivery-1') : result.current.onReview(ORDER_ID)));

    expect(arrayBuffer).toHaveBeenCalledTimes(1);
  });

  it('FREQ-539-AC-05: 次の操作を始めると、前の断りの文と知らせを消す', async () => {
    const { result } = await ready();
    postAnswer = () => refused(403);
    await trigger(result, () => result.current.onReview(ORDER_ID));
    expect(result.current.errorMessage).not.toBeNull();

    postAnswer = () => ok();
    await trigger(result, () => result.current.onReview(ORDER_ID));

    expect(result.current.errorMessage).toBeNull();
    expect(result.current.noticeMessage).toBe('確認済みにしました。');
  });
});
