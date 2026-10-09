import { after } from 'next/server';
import { runOrderEmailWorker } from '@/lib/orders/email/order-email-worker';

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * 行を書いた窓口の返事の後に、注文のメールの worker を1回動かす（設計書 4-7）。ふだんは数秒で届く。
 * 動かせなくても、毎分の定期処理が送る。
 */
export function scheduleOrderEmailDelivery(): void {
  try {
    after(() =>
      runOrderEmailWorker().then(
        () => undefined,
        (error: unknown) => {
          console.error('[order-email] inline worker run failed', errorName(error));
        },
      ),
    );
  } catch (error) {
    // after() はリクエストの外（試験や定期処理の外の呼び出し）では使えない
    console.warn('[order-email] inline delivery was not scheduled', errorName(error));
  }
}
