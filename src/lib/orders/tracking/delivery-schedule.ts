import 'server-only';
import { after } from 'next/server';
import { runDeliveryTrackingWorker } from '@/lib/orders/tracking/delivery-worker';

/** afterが動かなかった場合も、DBに残った予定を毎分の処理が回収する。 */
export function scheduleDeliveryTracking(): void {
  try {
    after(async () => {
      try { await runDeliveryTrackingWorker(); }
      catch (error) {
        console.error('[delivery-tracking] inline worker run failed', error instanceof Error ? error.name : 'UnknownError');
      }
    });
  } catch (error) {
    console.warn('[delivery-tracking] inline worker was not scheduled', error instanceof Error ? error.name : 'UnknownError');
  }
}
