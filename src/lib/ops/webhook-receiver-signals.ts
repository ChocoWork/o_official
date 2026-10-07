import { bumpSignal, claimAlert, type OpsStore } from '@/lib/ops/ops-store';
import { modeMismatchMail, signatureAlertMail, type OpsAlertMail } from '@/lib/ops/ops-alert-mail';

/**
 * 受け取り口の署名不正とモード違いを数え、多いときだけ店へ知らせる（設計書 2026-10-05 グループ B の 5-2・6）。
 * 1件ずつ監査ログに書かず、同じ1行の件数を進める（R-05）。受け取り口の返事を壊さないよう、例外は外へ出さない。
 * 送信に失敗しても権利は返さず、種類ごとに1時間に1回だけ試す（Ruling T7-R1）。
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
  // 数がしきい値ちょうどのときだけ権利を取りにいく。窓ごとに1回で、しきい値を超えた後の要求ごとには取りにいかない
  if (count !== signal.threshold) return;
  const alertMail = mail(count);
  if (!(await claimAlert(deps.store, signal.key, signal.cooldownSeconds))) return;
  // 送れなくても権利は返さない。返すと、次に届いた不正な呼び出しのたびに送り直し、
  // 送りの失敗の監査が1件ずつ増える（R-05）。種類ごとに1時間に1回だけ試す（Ruling T7-R1）
  await deps.send(alertMail);
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
