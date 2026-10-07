import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';

const mockExpireOpenCheckoutSession = jest.fn();
jest.mock('@/lib/stripe/checkout-session-expiry', () => ({
  expireOpenCheckoutSession: (...args: unknown[]) => mockExpireOpenCheckoutSession(...args),
}));

import {
  closeOtherCheckoutSessions,
  findPaidCheckoutSession,
} from '@/features/checkout/services/checkout-session-lifecycle.service';

const NOW = new Date('2026-10-08T03:00:00.000Z');

/** select から limit まで、呼んだ順に記録して最後に結果を返す PostgREST の鎖 */
function queryChain(result: { data: unknown; error: unknown }) {
  const calls: Array<[string, unknown[]]> = [];
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'not', 'neq', 'gte', 'or', 'order', 'limit']) {
    chain[method] = (...args: unknown[]) => {
      calls.push([method, args]);
      return chain;
    };
  }
  chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return { chain, calls };
}

function supabaseWith(result: { data: unknown; error: unknown }) {
  const { chain, calls } = queryChain(result);
  const from = jest.fn().mockReturnValue(chain);
  const rpc = jest.fn().mockResolvedValue({ data: true, error: null });
  return { client: { from, rpc } as unknown as SupabaseClient, from, rpc, calls };
}

describe('findPaidCheckoutSession', () => {
  test('このカートの受け付け済みの注文（24時間以内・新しい順に3件）から、支払いの済んだ決済の画面を返す', async () => {
    const { client, from, calls } = supabaseWith({
      data: [{ checkout_session_id: 'cs_open' }, { checkout_session_id: 'cs_paid' }],
      error: null,
    });
    const retrieve = jest
      .fn()
      .mockResolvedValueOnce({ id: 'cs_open', status: 'open' })
      .mockResolvedValueOnce({ id: 'cs_paid', status: 'complete' });
    const stripe = { checkout: { sessions: { retrieve } } } as unknown as Stripe;

    await expect(findPaidCheckoutSession({ supabase: client, stripe }, 'sess-abc', NOW)).resolves.toBe('cs_paid');

    expect(from).toHaveBeenCalledWith('orders');
    expect(calls).toEqual([
      ['select', ['checkout_session_id']],
      ['eq', ['session_id', 'sess-abc']],
      ['eq', ['status', 'payment_in_progress']],
      ['not', ['checkout_session_id', 'is', null]],
      ['gte', ['created_at', '2026-10-07T03:00:00.000Z']],
      ['order', ['created_at', { ascending: false }]],
      ['limit', [3]],
    ]);
  });

  test('支払いの済んだものが無ければ null', async () => {
    const { client } = supabaseWith({ data: [{ checkout_session_id: 'cs_open' }], error: null });
    const retrieve = jest.fn().mockResolvedValue({ id: 'cs_open', status: 'open' });
    const stripe = { checkout: { sessions: { retrieve } } } as unknown as Stripe;

    await expect(findPaidCheckoutSession({ supabase: client, stripe }, 'sess-abc', NOW)).resolves.toBeNull();
  });

  test('DB の失敗は投げる', async () => {
    const { client } = supabaseWith({ data: null, error: { message: 'boom' } });
    const stripe = { checkout: { sessions: { retrieve: jest.fn() } } } as unknown as Stripe;

    await expect(findPaidCheckoutSession({ supabase: client, stripe }, 'sess-abc', NOW)).rejects.toEqual({
      message: 'boom',
    });
  });
});

describe('closeOtherCheckoutSessions', () => {
  const stripe = {} as Stripe;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function deps(client: SupabaseClient) {
    return {
      supabase: client,
      stripe,
      reconcile: jest.fn().mockResolvedValue(undefined),
      logFailure: jest.fn().mockResolvedValue(undefined),
    };
  }

  test('同じセッションの、残している画面以外の決済の画面を探す（24時間以内・まだ失効していない・新しい順に10件）', async () => {
    const { client, from, calls } = supabaseWith({ data: [], error: null });

    await closeOtherCheckoutSessions(deps(client), { cartSessionId: 'sess-abc', keepCheckoutSessionId: 'cs_keep' }, NOW);

    expect(from).toHaveBeenCalledWith('checkout_drafts');
    expect(calls).toEqual([
      ['select', ['id, status, checkout_session_id, checkout_request_version, checkout_request_fingerprint']],
      ['eq', ['session_id', 'sess-abc']],
      ['in', ['status', ['created', 'completed']]],
      ['not', ['checkout_session_id', 'is', null]],
      ['neq', ['checkout_session_id', 'cs_keep']],
      ['gte', ['created_at', '2026-10-07T03:00:00.000Z']],
      ['or', ['checkout_session_expires_at.is.null,checkout_session_expires_at.gt.2026-10-08T03:00:00.000Z']],
      ['order', ['created_at', { ascending: false }]],
      ['limit', [10]],
    ]);
  });

  test('受け付け済みの下書きの画面を閉じたら、照合関数で放棄の扱いにする。閉じていなければ照合しない', async () => {
    const { client } = supabaseWith({
      data: [
        { id: 'd1', status: 'completed', checkout_session_id: 'cs_accepted', checkout_request_version: 2, checkout_request_fingerprint: 'v2:a' },
        { id: 'd2', status: 'completed', checkout_session_id: 'cs_paid', checkout_request_version: 2, checkout_request_fingerprint: 'v2:b' },
      ],
      error: null,
    });
    mockExpireOpenCheckoutSession.mockResolvedValueOnce('expired').mockResolvedValueOnce('not_open');
    const d = deps(client);

    await closeOtherCheckoutSessions(d, { cartSessionId: 'sess-abc', keepCheckoutSessionId: 'cs_keep' }, NOW);

    expect(mockExpireOpenCheckoutSession.mock.calls.map((call) => call[1])).toEqual(['cs_accepted', 'cs_paid']);
    expect(d.reconcile).toHaveBeenCalledTimes(1);
    expect(d.reconcile).toHaveBeenCalledWith('cs_accepted');
  });

  test('作成中の下書きの画面を閉じたら下書きを退役させる。閉じていなければ（支払いが済んだなど）触らない', async () => {
    const { client, rpc } = supabaseWith({
      data: [
        { id: 'd1', status: 'created', checkout_session_id: 'cs_a', checkout_request_version: 2, checkout_request_fingerprint: 'v2:a' },
        { id: 'd2', status: 'created', checkout_session_id: 'cs_b', checkout_request_version: 2, checkout_request_fingerprint: 'v2:b' },
      ],
      error: null,
    });
    mockExpireOpenCheckoutSession.mockResolvedValueOnce('expired').mockResolvedValueOnce('not_open');
    const d = deps(client);

    await closeOtherCheckoutSessions(d, { cartSessionId: 'sess-abc', keepCheckoutSessionId: 'cs_keep' }, NOW);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('retire_expired_checkout_draft', {
      _draft_id: 'd1',
      _session_id: 'sess-abc',
      _checkout_session_id: 'cs_a',
      _request_version: 2,
      _request_fingerprint: 'v2:a',
    });
    expect(d.reconcile).not.toHaveBeenCalled();
  });

  test('1件で失敗しても残りを続け、失敗は理由だけ残す。投げない', async () => {
    const { client } = supabaseWith({
      data: [
        { id: 'd1', status: 'completed', checkout_session_id: 'cs_fail', checkout_request_version: 2, checkout_request_fingerprint: 'v2:a' },
        { id: 'd2', status: 'completed', checkout_session_id: 'cs_ok', checkout_request_version: 2, checkout_request_fingerprint: 'v2:b' },
      ],
      error: null,
    });
    mockExpireOpenCheckoutSession.mockRejectedValueOnce(new Error('stripe down')).mockResolvedValueOnce('expired');
    const d = deps(client);

    await expect(
      closeOtherCheckoutSessions(d, { cartSessionId: 'sess-abc', keepCheckoutSessionId: 'cs_keep' }, NOW),
    ).resolves.toBeUndefined();

    expect(d.logFailure).toHaveBeenCalledWith('Failed to close other checkout session', {
      draft_id: 'd1',
      checkout_session_id: 'cs_fail',
    });
    expect(d.reconcile).toHaveBeenCalledWith('cs_ok');
  });

  test('一覧を読めなければ残して終わる。投げない', async () => {
    const { client } = supabaseWith({ data: null, error: { message: 'boom', code: '57014' } });
    const d = deps(client);

    await expect(
      closeOtherCheckoutSessions(d, { cartSessionId: 'sess-abc', keepCheckoutSessionId: 'cs_keep' }, NOW),
    ).resolves.toBeUndefined();

    expect(d.logFailure).toHaveBeenCalledWith('Failed to list other checkout sessions', { error_code: '57014' });
    expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
  });
});
