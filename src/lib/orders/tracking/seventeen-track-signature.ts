import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { TrackingSignal } from '@/lib/orders/tracking/delivery-types';
import { isSeventeenTrackCarrier } from '@/lib/orders/tracking/seventeen-track-status';

export function verifySeventeenTrackSignature(raw: Uint8Array, sign: string | null, key: string): boolean {
  if (typeof sign !== 'string' || sign.length !== 64 || !/^[0-9a-f]+$/i.test(sign)) return false;
  const expected = createHash('sha256').update(raw).update('/', 'utf8').update(key, 'utf8').digest();
  const supplied = Buffer.from(sign, 'hex');
  return supplied.length === expected.length && timingSafeEqual(expected, supplied);
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid tracking signal');
  }
  return value as Record<string, unknown>;
}

export function parseTrackingSignals(value: unknown): TrackingSignal[] {
  const signals: TrackingSignal[] = [];
  for (const entry of Array.isArray(value) ? value : [value]) {
    const row = object(entry);
    if (typeof row.event !== 'string') throw new TypeError('Invalid tracking signal');
    if (row.event !== 'TRACKING_UPDATED' && row.event !== 'TRACKING_STOPPED') continue;

    const data = object(row.data);
    if (typeof data.carrier !== 'number' || !Number.isInteger(data.carrier)) {
      throw new TypeError('Invalid tracking signal');
    }
    if (!isSeventeenTrackCarrier(data.carrier)) continue;
    if (typeof data.number !== 'string' || !data.number.trim()) throw new TypeError('Invalid tracking signal');

    // track_info・param・tagは読み直しにも保存する値にも使わない。
    signals.push({ carrier: data.carrier, number: data.number, event: row.event });
  }
  return signals;
}
