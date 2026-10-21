import 'server-only';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { recordHeartbeat, type OpsStore } from '@/lib/ops/ops-store';
import { readDeliveryTrackingConfig } from '@/lib/orders/tracking/delivery-config';
import { reportDeliveryTrackingIssue, type DeliveryOpsKind } from '@/lib/orders/tracking/delivery-ops';
import {
  claimDeliveryTracking, expireDeliveryTracking, getDeliveryTrackingSettings,
  recordDeliveryReadResult, recordDeliveryRegistrationResult, recordDeliveryStopResult,
  takeDeliveryProviderSlot, type DeliveryStore,
} from '@/lib/orders/tracking/delivery-store';
import {
  createSeventeenTrackClient, type ProviderItemResult, type ProviderPair, type SeventeenTrackClient,
} from '@/lib/orders/tracking/seventeen-track-client';
import { SEVENTEEN_TRACK_CARRIERS } from '@/lib/orders/tracking/seventeen-track-status';
import type { DeliveryReadResult, RegistrationOutcome, TrackingAction, TrackingClaim } from '@/lib/orders/tracking/delivery-types';

export const DELIVERY_TRACKING_BUDGET_MS = 8000;
export const DELIVERY_TRACKING_MIN_BUDGET_MS = 3000;
export const DELIVERY_TRACKING_POLL_SECONDS = 21600;
export type DeliveryWorkerResult = {
  registered: number; read: number; stopped: number; expired: number;
  stoppedBy: 'empty' | 'budget' | 'disabled' | 'key_missing' | 'error';
};
export type DeliveryWorkerDeps = {
  store: DeliveryStore; provider: SeventeenTrackClient; now: () => number;
  wait: (ms: number) => Promise<void>; report: (kind: DeliveryOpsKind) => Promise<void>;
};

const ACTIONS = ['stop', 'register', 'retrack', 'read'] as const;
const METHODS = { stop: 'stopTrack', register: 'register', retrack: 'retrack', read: 'getTrackInfo' } as const;
const REGISTRATION_OUTCOMES: readonly RegistrationOutcome[] = ['registered', 'invalid_number', 'transient', 'account', 'retrack_exhausted'];
const MIN_REMAINING_MS = 500;
const PROVIDER_INTERVAL_MS = 334;

function pairOf(claim: TrackingClaim): ProviderPair {
  return { number: claim.trackingNumber.toUpperCase(), carrier: SEVENTEEN_TRACK_CARRIERS[claim.carrier] };
}
function pairKey(pair: ProviderPair): string { return JSON.stringify([pair.carrier, pair.number.toUpperCase()]); }
function failedItem(pair: ProviderPair, action: TrackingAction, code: string, now: number): ProviderItemResult {
  const read: DeliveryReadResult | null = action === 'read' ? {
    outcome: 'transient', status: null, providerStatus: null, providerSubStatus: null,
    happenedAt: null, deliveredAt: null, readAt: new Date(now).toISOString(), errorCode: code,
  } : null;
  return { pair, outcome: 'transient', errorCode: code, read };
}
function logFailure(error: unknown): void {
  console.error('[delivery-tracking] worker failed', error instanceof Error ? error.name : 'UnknownError');
}

export async function processDeliveryTracking(deps: DeliveryWorkerDeps, options: { budgetMs: number }): Promise<DeliveryWorkerResult> {
  // 設定・expire・claim・wait・結果保存も開始からの実時間に含める。
  const startedAt = deps.now();
  const budget = Math.max(0, Math.min(DELIVERY_TRACKING_BUDGET_MS, options.budgetMs));
  const remaining = () => Math.max(0, budget - (deps.now() - startedAt));
  const result: DeliveryWorkerResult = { registered: 0, read: 0, stopped: 0, expired: 0, stoppedBy: 'empty' };
  let failed = false;
  let lastHttpStartedAt: number | null = null;
  const finish = (reason: DeliveryWorkerResult['stoppedBy']) => ({ ...result, stoppedBy: failed ? 'error' as const : reason });
  async function report(kind: DeliveryOpsKind): Promise<void> {
    try { await deps.report(kind); } catch (error) { failed = true; logFailure(error); }
  }
  async function active(): Promise<'disabled' | 'key_missing' | null> {
    if (!(await getDeliveryTrackingSettings(deps.store)).enabled) return 'disabled';
    if (!readDeliveryTrackingConfig(process.env).apiKey) {
      failed = true;
      await report('key_missing');
      return 'key_missing';
    }
    return null;
  }
  try {
    const inactive = await active();
    if (inactive) return { ...result, stoppedBy: inactive };
    if (remaining() <= MIN_REMAINING_MS) return finish('budget');
    result.expired = await expireDeliveryTracking(deps.store, 1000);
    while (remaining() > MIN_REMAINING_MS) {
      const claims = await claimDeliveryTracking(deps.store, { limit: 40, leaseSeconds: 60 });
      if (claims.length === 0) return finish('empty');
      for (const action of ACTIONS) {
        const group = claims.filter((claim) => claim.action === action);
        for (let offset = 0; offset < group.length; offset += 40) {
          if (remaining() <= MIN_REMAINING_MS) return finish('budget');
          const batch = group.slice(offset, offset + 40);
          const reservedWait = await takeDeliveryProviderSlot(deps.store);
          const spacingWait = lastHttpStartedAt === null ? 0 : Math.max(0, lastHttpStartedAt + PROVIDER_INTERVAL_MS - deps.now());
          const waitMs = Math.max(reservedWait, spacingWait);
          // 予約は取り消せない。枠を取り直すと空振りのたびに334ms先へ進むため、この回を終える。
          if (waitMs >= remaining() - MIN_REMAINING_MS) return finish('budget');
          if (waitMs > 0) await deps.wait(waitMs);
          const inactiveNow = await active();
          if (inactiveNow) return { ...result, stoppedBy: inactiveNow };
          if (remaining() <= MIN_REMAINING_MS) return finish('budget');
          const pairs = batch.map(pairOf);
          let answers: ProviderItemResult[];
          lastHttpStartedAt = deps.now();
          try {
            answers = await deps.provider[METHODS[action]](pairs, { timeoutMs: Math.min(2500, remaining()) });
          } catch (error) {
            failed = true; logFailure(error);
            answers = pairs.map((pair) => failedItem(pair, action, 'provider_error', deps.now()));
          }
          const byPair = new Map<string, ProviderItemResult[]>();
          for (const answer of answers) {
            const key = pairKey(answer.pair);
            byPair.set(key, [...(byPair.get(key) ?? []), answer]);
          }
          for (const claim of batch) {
            const matches = byPair.get(pairKey(pairOf(claim)));
            const answer = matches?.length === 1 ? matches[0] : failedItem(pairOf(claim), action, 'invalid_response', deps.now());
            let applied: boolean;
            let issue: DeliveryOpsKind | null = null;
            if (action === 'stop') {
              const succeeded = answer.outcome === 'stopped' || answer.outcome === 'not_registered';
              applied = await recordDeliveryStopResult(deps.store, claim, succeeded, answer.errorCode);
              if (applied && succeeded) result.stopped++;
              if (applied && !succeeded) failed = true;
              if (answer.outcome === 'account') issue = 'account_error';
            } else if (action === 'read') {
              // provider_statusも含めclientの答えをそのままDBへ渡す。OFF・版・tokenの最終確認もDBが行う。
              const read = answer.read ?? failedItem(pairOf(claim), action, 'invalid_response', deps.now()).read!;
              applied = (await recordDeliveryReadResult(deps.store, claim, read)).applied;
              if (applied) {
                if (read.outcome !== 'transient' && read.outcome !== 'account') result.read++;
                else failed = true;
              }
              if (read.outcome === 'account') issue = 'account_error';
              else if (read.outcome === 'transient' && claim.readAttempts + 1 >= 5) issue = 'read_failed';
              else if (read.outcome === 'ok' && read.status === null && read.providerStatus !== null) issue = 'unknown_status';
            } else {
              const outcome = REGISTRATION_OUTCOMES.includes(answer.outcome as RegistrationOutcome)
                ? answer.outcome as RegistrationOutcome : 'transient';
              applied = (await recordDeliveryRegistrationResult(deps.store, claim, outcome, answer.errorCode)).applied;
              if (applied && outcome === 'registered') result.registered++;
              if (applied && (outcome === 'transient' || outcome === 'account')) failed = true;
              if (outcome === 'account') issue = 'account_error';
            }
            // 失効した結果を成功件数や運用通知に使わない。
            if (applied && issue) await report(issue);
          }
        }
      }
    }
    return finish('budget');
  } catch (error) {
    failed = true; logFailure(error);
    // 定期処理の引数拒否も実装・契約の失敗。画面向けの断りとして捨てない。
    await report('read_failed');
    return finish('error');
  }
}

export async function runDeliveryTrackingWorker(options?: { budgetMs?: number }): Promise<DeliveryWorkerResult> {
  const startedAt = Date.now();
  let store: (DeliveryStore & OpsStore) | undefined;
  let result: DeliveryWorkerResult = { registered: 0, read: 0, stopped: 0, expired: 0, stoppedBy: 'error' };
  try {
    store = await createServiceRoleClient() as unknown as DeliveryStore & OpsStore;
    const config = readDeliveryTrackingConfig(process.env);
    const provider = createSeventeenTrackClient({ apiKey: config.apiKey ?? '', baseUrl: config.baseUrl,
      fetch, timeoutMs: 2500, now: () => new Date() });
    result = await processDeliveryTracking({ store, provider, now: () => Date.now(),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      report: (kind) => reportDeliveryTrackingIssue(store!, kind),
    }, { budgetMs: Math.max(0, Math.min(options?.budgetMs ?? DELIVERY_TRACKING_BUDGET_MS, DELIVERY_TRACKING_BUDGET_MS) - (Date.now() - startedAt)) });
  } catch (error) { logFailure(error); }
  if (store) {
    try {
      const succeeded = result.stoppedBy !== 'error' && result.stoppedBy !== 'key_missing';
      await recordHeartbeat(store, 'delivery_tracking', succeeded,
        succeeded ? null : result.stoppedBy === 'key_missing' ? 'key_missing' : 'delivery_tracking_error');
    } catch (error) { logFailure(error); }
  }
  return result;
}
