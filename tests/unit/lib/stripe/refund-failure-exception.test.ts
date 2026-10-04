import { ReconcileTransientError } from '@/lib/stripe/checkout-payment-reader';
import type { ReconcilerDatabase, ReconcilerMailer } from '@/lib/stripe/checkout-payment-reconciler';
import { raiseRefundFailureWithoutOrder } from '@/lib/stripe/refund-failure-exception';

/**
 * 注文に結び付いていない支払いの返金が、失敗・取消のまま終わったときの要対応。
 * 要対応の記録・送信権の RPC と同じ振る舞いを、メモリ上で再現する
 * （同じ支払い・同じ理由は1行。送信権は1回だけ取れる。解決済みの行は知らせ直さない）。
 */
const NOW = new Date('2026-10-04T03:00:00.000Z');
const INPUT = { paymentIntentId: 'pi_orphan', refundId: 're_failed_1', refundStatus: 'failed' } as const;

function fakes(options: { resolved?: boolean } = {}) {
  const exceptions = new Map<string, string>();
  const claimed = new Set<string>();

  const database = {
    recordException: jest.fn(async (args: { paymentRef: string; reason: string }) => {
      const key = `${args.paymentRef}:${args.reason}`;
      const existing = exceptions.get(key);
      if (existing) {
        return { exceptionId: existing, isNew: false, isResolved: options.resolved ?? false };
      }
      const id = `exception-${exceptions.size + 1}`;
      exceptions.set(key, id);
      return { exceptionId: id, isNew: true, isResolved: false };
    }),
    claimExceptionNotification: jest.fn(async (exceptionId: string, channel: string) => {
      const key = `${exceptionId}:${channel}`;
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    }),
    releaseExceptionNotification: jest.fn(async (exceptionId: string, channel: string) => {
      claimed.delete(`${exceptionId}:${channel}`);
    }),
  };
  const mailer = { sendShopAlert: jest.fn(async () => true) };

  return {
    database,
    mailer,
    deps: {
      database: database as unknown as ReconcilerDatabase,
      mailer: mailer as unknown as ReconcilerMailer,
      now: () => NOW,
    },
  };
}

describe('raiseRefundFailureWithoutOrder', () => {
  it('既存の理由（unexpected_state）で要対応を記録し、店へ1回知らせる。ID 以外は入れない', async () => {
    const f = fakes();

    const result = await raiseRefundFailureWithoutOrder(f.deps, INPUT);

    expect(result).toEqual({ exceptionId: 'exception-1', isNew: true });
    expect(f.database.recordException).toHaveBeenCalledTimes(1);
    expect(f.database.recordException).toHaveBeenCalledWith({
      paymentRef: 're_failed_1',
      reason: 'unexpected_state',
      detail: 'refund_failed_without_order',
      checkoutSessionId: null,
      paymentIntentId: 'pi_orphan',
      draftId: null,
      orderId: null,
    });
    expect(f.database.claimExceptionNotification).toHaveBeenCalledWith('exception-1', 'shop');
    expect(f.mailer.sendShopAlert).toHaveBeenCalledTimes(1);
    expect(f.mailer.sendShopAlert).toHaveBeenCalledWith({
      reason: 'unexpected_state',
      detail: 'refund_failed_without_order',
      orderId: null,
      paymentRef: 're_failed_1',
      detectedAt: NOW,
    });
  });

  it('取消の返金は、取消を表す detail で記録する', async () => {
    const f = fakes();

    await raiseRefundFailureWithoutOrder(f.deps, { ...INPUT, refundId: 're_canceled_1', refundStatus: 'canceled' });

    expect(f.database.recordException).toHaveBeenCalledWith(expect.objectContaining({
      paymentRef: 're_canceled_1',
      detail: 'refund_canceled_without_order',
    }));
    expect(f.mailer.sendShopAlert).toHaveBeenCalledWith(expect.objectContaining({
      detail: 'refund_canceled_without_order',
    }));
  });

  it.each(['failed', 'canceled'] as const)('%s の detail は DB の CHECK（英小文字・数字・_ の64文字まで）に収まる', async (refundStatus) => {
    const f = fakes();

    await raiseRefundFailureWithoutOrder(f.deps, { ...INPUT, refundStatus });

    const [{ detail }] = f.database.recordException.mock.calls[0] as unknown as [{ detail: string }];
    expect(detail).toMatch(/^[a-z0-9_]{1,64}$/);
  });

  it('同じ返金のイベントが何度届いても、要対応も通知も増やさない', async () => {
    const f = fakes();

    const first = await raiseRefundFailureWithoutOrder(f.deps, INPUT);
    const second = await raiseRefundFailureWithoutOrder(f.deps, INPUT);
    const third = await raiseRefundFailureWithoutOrder(f.deps, INPUT);

    expect([first.exceptionId, second.exceptionId, third.exceptionId]).toEqual(['exception-1', 'exception-1', 'exception-1']);
    expect([first.isNew, second.isNew, third.isNew]).toEqual([true, false, false]);
    expect(f.mailer.sendShopAlert).toHaveBeenCalledTimes(1);
  });

  it('同じ支払いの別の返金が失敗したときは、別の要対応として店へ知らせる', async () => {
    const f = fakes();

    const first = await raiseRefundFailureWithoutOrder(f.deps, INPUT);
    const other = await raiseRefundFailureWithoutOrder(f.deps, { ...INPUT, refundId: 're_failed_2' });

    expect(other.exceptionId).not.toBe(first.exceptionId);
    expect(f.mailer.sendShopAlert).toHaveBeenCalledTimes(2);
  });

  it('解決済みの要対応は、再び検知しても知らせ直さない', async () => {
    const f = fakes({ resolved: true });
    await raiseRefundFailureWithoutOrder(f.deps, INPUT);
    f.database.claimExceptionNotification.mockClear();
    f.mailer.sendShopAlert.mockClear();

    // 2回目は既存の行（解決済み）に当たる
    await raiseRefundFailureWithoutOrder(f.deps, INPUT);

    expect(f.database.claimExceptionNotification).not.toHaveBeenCalled();
    expect(f.mailer.sendShopAlert).not.toHaveBeenCalled();
  });

  it('店へのメールが送れなければ送信権を戻す（毎時の見回りが送り直す）。失敗にはしない', async () => {
    const f = fakes();
    f.mailer.sendShopAlert.mockResolvedValueOnce(false);

    await expect(raiseRefundFailureWithoutOrder(f.deps, INPUT)).resolves.toEqual({ exceptionId: 'exception-1', isNew: true });

    expect(f.database.releaseExceptionNotification).toHaveBeenCalledWith('exception-1', 'shop');
  });

  it('要対応を記録できなければ（一時的な失敗でも）、握りつぶさず投げる。メールは送らない', async () => {
    const f = fakes();
    const transient = new ReconcileTransientError('db_unavailable');
    f.database.recordException.mockRejectedValueOnce(transient);

    await expect(raiseRefundFailureWithoutOrder(f.deps, INPUT)).rejects.toBe(transient);

    expect(f.mailer.sendShopAlert).not.toHaveBeenCalled();
  });

  it('送信権を取れなければ（DB の失敗）、握りつぶさず投げる', async () => {
    const f = fakes();
    const failure = new ReconcileTransientError('db_unavailable');
    f.database.claimExceptionNotification.mockRejectedValueOnce(failure);

    await expect(raiseRefundFailureWithoutOrder(f.deps, INPUT)).rejects.toBe(failure);

    expect(f.mailer.sendShopAlert).not.toHaveBeenCalled();
  });
});
