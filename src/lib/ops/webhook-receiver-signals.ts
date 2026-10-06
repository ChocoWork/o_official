import { bumpSignal, claimAlert, releaseAlert, type OpsStore } from '@/lib/ops/ops-store';
import { modeMismatchMail, signatureAlertMail, type OpsAlertMail } from '@/lib/ops/ops-alert-mail';

/**
 * 受け取り口の署名不正とモード違いを数え、多いときだけ店へ知らせる（設計書 2026-10-05 グループ B の 5-2・6）。
 * 1件ずつ監査ログに書かず、同じ1行の件数を進める（R-05）。受け取り口の返事を壊さないよう、例外は外へ出さない。
 */
export const SIGNATURE_ALERT = {
  key: 'webhook_signature_invalid',
  windowSeconds: 600,
  threshold: 5,
  cooldownSeconds: 3600,
} as const;

export const MODE_MISMATCH_ALERT = {
  key: 'webhook_mode_mismatch',
  windowSeconds: 3600,
  threshold: 1,
  cooldownSeconds: 3600,
} as const;

export type SignalDeps = { store: OpsStore; send: (mail: OpsAlertMail) => Promise<boolean> };

type Signal = typeof SIGNATURE_ALERT | typeof MODE_MISMATCH_ALERT;

async function countAndAlert(deps: SignalDeps, signal: Signal, mail: (count: number) => OpsAlertMail): Promise<void> {
  const count = await bumpSignal(deps.store, signal.key, signal.windowSeconds);
  if (count < signal.threshold) return;
  const claim = await claimAlert(deps.store, signal.key, signal.cooldownSeconds);
  if (!claim) return;
  if (!(await deps.send(mail(count)))) await releaseAlert(deps.store, claim);
}

function logFailure(what: string, error: unknown): void {
  console.error(`[webhook] Failed to record ${what}`, error instanceof Error ? error.name : 'UnknownError');
}

export async function recordSignatureFailure(deps: SignalDeps): Promise<void> {
  try {
    await countAndAlert(deps, SIGNATURE_ALERT, (count) => signatureAlertMail(count));
  } catch (error) {
    logFailure('signature failure', error);
  }
}

export async function recordModeMismatch(
  deps: SignalDeps,
  eventLivemode: boolean,
  keyLivemode: boolean | null,
): Promise<void> {
  try {
    await countAndAlert(deps, MODE_MISMATCH_ALERT, () => modeMismatchMail(eventLivemode, keyLivemode));
  } catch (error) {
    logFailure('mode mismatch', error);
  }
}
