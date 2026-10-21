import 'server-only';
import type { DeliveryReadResult, RegistrationOutcome } from '@/lib/orders/tracking/delivery-types';
import { mapSeventeenTrackStatus, SEVENTEEN_TRACK_CARRIERS } from '@/lib/orders/tracking/seventeen-track-status';

export type ProviderPair = { number: string; carrier: 100062 | 100040 | 10021 };
export type ProviderItemResult = {
  pair: ProviderPair;
  outcome: RegistrationOutcome | 'not_registered' | 'not_found' | 'stopped';
  errorCode: string | null;
  read: DeliveryReadResult | null;
};
export type ProviderCallOptions = { timeoutMs?: number };
export type SeventeenTrackClient = {
  register(pairs: ProviderPair[], options?: ProviderCallOptions): Promise<ProviderItemResult[]>;
  retrack(pairs: ProviderPair[], options?: ProviderCallOptions): Promise<ProviderItemResult[]>;
  getTrackInfo(pairs: ProviderPair[], options?: ProviderCallOptions): Promise<ProviderItemResult[]>;
  stopTrack(pairs: ProviderPair[], options?: ProviderCallOptions): Promise<ProviderItemResult[]>;
};

type Method = 'register' | 'retrack' | 'gettrackinfo' | 'stoptrack';
type Outcome = ProviderItemResult['outcome'];
type ResponseRow = { accepted: boolean; row: Record<string, unknown> };

const INVALID_NUMBER_CODES = new Set([-18010011, -18010012, -18010013, -18010015, -18019903, -18019910, -18019911]);
const ACCOUNT_CODES = new Set([-18019907, -18019908, -18010001, -18010002, -18010004, -18010005]);

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function codeOutcome(code: number, method: Method): Outcome {
  if (code === -18019901 || code === -18019904) return 'registered';
  if (INVALID_NUMBER_CODES.has(code)) return 'invalid_number';
  if (ACCOUNT_CODES.has(code)) return 'account';
  if (code === -18019905) return 'retrack_exhausted';
  if (code === -18019902 && (method === 'gettrackinfo' || method === 'stoptrack')) return 'not_registered';
  if (code === -18019906 && method === 'stoptrack') return 'stopped';
  if (code === -18019909) return 'not_found';
  return 'transient';
}

function emptyRead(outcome: DeliveryReadResult['outcome'], errorCode: string | null, readAt: string): DeliveryReadResult {
  return {
    outcome, status: null, providerStatus: null, providerSubStatus: null,
    happenedAt: null, deliveredAt: null, readAt, errorCode,
  };
}

function failure(pair: ProviderPair, method: Method, outcome: Outcome, errorCode: string, readAt: string): ProviderItemResult {
  const readOutcome = outcome === 'not_found' || outcome === 'not_registered' || outcome === 'invalid_number' || outcome === 'account'
    ? outcome : 'transient';
  return { pair, outcome, errorCode, read: method === 'gettrackinfo' ? emptyRead(readOutcome, errorCode, readAt) : null };
}

/** offsetのないISOは採用しない。time_utcだけを明示的なUTCに変える。 */
function timestamp(value: unknown, utc: boolean): string | null {
  if (typeof value !== 'string') return null;
  const pattern = utc
    ? /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
    : /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
  const match = pattern.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) return null;
  const millis = Date.parse(utc ? `${value.replace(' ', 'T')}Z` : value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function providerTime(value: unknown): string | null {
  const row = object(value);
  return row ? timestamp(row.time_iso, false) ?? timestamp(row.time_utc, true) : null;
}

function readTracking(value: unknown, readAt: string): DeliveryReadResult | null {
  const info = object(value);
  const latestStatus = object(info?.latest_status);
  if (!info || !latestStatus || typeof latestStatus.status !== 'string' || !latestStatus.status) return null;
  if (latestStatus.sub_status != null && typeof latestStatus.sub_status !== 'string') return null;
  const providerStatus = latestStatus.status;
  const providerSubStatus = typeof latestStatus.sub_status === 'string' ? latestStatus.sub_status : null;
  const status = mapSeventeenTrackStatus(providerStatus, providerSubStatus);
  if (status === 'not_found') {
    return { ...emptyRead('not_found', null, readAt), providerStatus, providerSubStatus };
  }

  const happenedAt = providerTime(info.latest_event) ?? readAt;
  let deliveredAt: string | null = null;
  if (status === 'delivered') {
    const milestones: unknown[] = Array.isArray(info.milestone) ? info.milestone : [];
    for (const value of milestones) {
      if (object(value)?.key_stage !== 'Delivered') continue;
      deliveredAt = providerTime(value);
      if (deliveredAt !== null) break;
    }
    deliveredAt ??= happenedAt;
  }
  return { outcome: 'ok', status, providerStatus, providerSubStatus, happenedAt, deliveredAt, readAt, errorCode: null };
}

function pairKey(pair: ProviderPair): string {
  return JSON.stringify([pair.number, pair.carrier]);
}

function responsePair(row: Record<string, unknown>): ProviderPair | null {
  if (typeof row.number !== 'string' || !row.number.trim()) return null;
  if (row.carrier !== SEVENTEEN_TRACK_CARRIERS.yamato
    && row.carrier !== SEVENTEEN_TRACK_CARRIERS.sagawa
    && row.carrier !== SEVENTEEN_TRACK_CARRIERS.japanpost) return null;
  return { number: row.number, carrier: row.carrier };
}

function parseResponse(value: unknown, pairs: ProviderPair[], method: Method, readAt: string): ProviderItemResult[] {
  const invalid = (pair: ProviderPair) => failure(pair, method, 'transient', 'invalid_response', readAt);
  const envelope = object(value);
  if (!envelope || typeof envelope.code !== 'number' || !Number.isInteger(envelope.code)) return pairs.map(invalid);
  if (envelope.code !== 0) {
    const code = envelope.code;
    return pairs.map((pair) => failure(pair, method, codeOutcome(code, method), String(code), readAt));
  }
  const data = object(envelope.data);
  if (!data || !Array.isArray(data.accepted) || !Array.isArray(data.rejected)) return pairs.map(invalid);

  const rows = new Map<string, ResponseRow[]>();
  for (const [accepted, entries] of [[true, data.accepted], [false, data.rejected]] as const) {
    for (const entry of entries) {
      const row = object(entry);
      const pair = row && responsePair(row);
      if (!row || !pair) continue;
      const key = pairKey(pair);
      const group = rows.get(key) ?? [];
      group.push({ accepted, row });
      rows.set(key, group);
    }
  }

  return pairs.map((pair) => {
    const group = rows.get(pairKey(pair));
    // 欠落・同じ組の複数の答えを成功に推測せず、その組だけ再試行へ戻す。
    if (!group || group.length !== 1) return invalid(pair);
    const { accepted, row } = group[0];
    if (!accepted) {
      const code = object(row.error)?.code;
      return typeof code === 'number' && Number.isInteger(code)
        ? failure(pair, method, codeOutcome(code, method), String(code), readAt) : invalid(pair);
    }
    if (method === 'gettrackinfo') {
      const read = readTracking(row.track_info, readAt);
      return read ? { pair, outcome: 'registered', errorCode: null, read } : invalid(pair);
    }
    return { pair, outcome: method === 'stoptrack' ? 'stopped' : 'registered', errorCode: null, read: null };
  });
}

export function createSeventeenTrackClient(input: {
  apiKey: string; baseUrl: string; fetch: typeof fetch; timeoutMs: number; now: () => Date;
}): SeventeenTrackClient {
  async function call(method: Method, pairs: ProviderPair[], options?: ProviderCallOptions): Promise<ProviderItemResult[]> {
    if (pairs.length > 40) throw new RangeError('At most 40 tracking pairs per call');
    if (pairs.length === 0) return [];
    // 入力の追加項目を送信にも戻り値にも混ぜない。
    const requested = pairs.map(({ number, carrier }) => ({ number, carrier }));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? input.timeoutMs);
    let readingBody = false;
    try {
      const response = await input.fetch(`${input.baseUrl.replace(/\/+$/, '')}/${method}`, {
        method: 'POST', headers: { '17token': input.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(requested), signal: controller.signal, redirect: 'error', cache: 'no-store',
      });
      if (!response.ok) {
        const outcome = response.status === 401 ? 'account' : 'transient';
        const readAt = input.now().toISOString();
        return requested.map((pair) => failure(pair, method, outcome, String(response.status), readAt));
      }
      readingBody = true;
      const body: unknown = await response.json();
      return parseResponse(body, requested, method, input.now().toISOString());
    } catch {
      const errorCode = controller.signal.aborted ? 'timeout' : readingBody ? 'invalid_response' : 'network';
      const readAt = input.now().toISOString();
      return requested.map((pair) => failure(pair, method, 'transient', errorCode, readAt));
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    register: (pairs, options) => call('register', pairs, options),
    retrack: (pairs, options) => call('retrack', pairs, options),
    getTrackInfo: (pairs, options) => call('gettrackinfo', pairs, options),
    stopTrack: (pairs, options) => call('stoptrack', pairs, options),
  };
}
