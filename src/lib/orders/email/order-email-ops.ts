import { readHeartbeats, type OpsStore } from '@/lib/ops/ops-store';
import { sendOnce } from '@/lib/ops/ops-checks';
import {
  orderEmailBacklogMail,
  orderEmailDeadDigestMail,
  orderEmailDeliveryProblemMail,
  orderEmailPausedMail,
  staleJobMail,
  type OpsAlertMail,
} from '@/lib/ops/ops-alert-mail';
import {
  getOrderEmailSendState,
  listUnnotifiedDeadOrderEmails,
  listUnnotifiedDeliveryProblems,
  markDeadOrderEmailsNotified,
  markDeliveryProblemsNotified,
  readOrderEmailBacklog,
  type OrderEmailStore,
} from '@/lib/orders/email/order-email-store';
import { orderEmailWorkerDisabledReason } from '@/lib/orders/email/order-email-worker';

/**
 * 注文のメールの点検（グループ D 設計書 4-6・4-8）。worker と毎時の見回りの終わりに呼ぶ。
 * - 一時停止: 止めていれば知らせる
 * - 溜まり: 書いてから15分以上送れていないメール
 * - 送れなかった・届かなかった: まだ知らせていない分をまとめて1通（50件まで）。送れた時だけ印を付ける
 * - worker の停止: 最後の成功から15分（一度も成功していなければ対象にしない）
 * 種類ごとに1時間に1回まで。点検の1つが失敗しても、残りは続ける。
 * worker を止める環境（Vercel の preview、本番の DB につないだ next dev）では、何も読み書きせず何も送らない。
 */
export const ORDER_EMAIL_OPS_LIMITS = {
  backlogAgeSeconds: 15 * 60,
  digestLimit: 50,
  staleAfterSeconds: 15 * 60,
} as const;

export type OrderEmailOpsDeps = {
  store: OpsStore & OrderEmailStore;
  send: (mail: OpsAlertMail) => Promise<boolean>;
  now: () => Date;
};

export type OrderEmailOpsResult = {
  pausedAlerted: boolean;
  backlogAlerted: boolean;
  deadNotified: number;
  deliveryNotified: number;
  staleAlerted: boolean;
  failedChecks: Array<'paused' | 'backlog' | 'dead' | 'delivery' | 'stale'>;
};

function logFailure(check: string, error: unknown): void {
  console.error(`[order-email-ops] ${check} check failed`, error instanceof Error ? error.name : 'UnknownError');
}

export async function runOrderEmailOpsChecks(deps: OrderEmailOpsDeps): Promise<OrderEmailOpsResult> {
  const result: OrderEmailOpsResult = {
    pausedAlerted: false,
    backlogAlerted: false,
    deadNotified: 0,
    deliveryNotified: 0,
    staleAlerted: false,
    failedChecks: [],
  };

  // worker と同じ環境の門。点検は「知らせ済み」の印を付け、店のメール受けへ送るので、
  // 本番の DB の知らせを、開発や preview が知らせ済みにしたり、手元のメール受けへ送ったりしないようにする
  const disabledReason = orderEmailWorkerDisabledReason();
  if (disabledReason) {
    console.warn('[order-email-ops] skipped', disabledReason);
    return result;
  }

  try {
    const state = await getOrderEmailSendState(deps.store);
    if (state.paused) {
      result.pausedAlerted = await sendOnce(deps, 'order_email_paused', orderEmailPausedMail(state));
    }
  } catch (error) {
    result.failedChecks.push('paused');
    logFailure('paused', error);
  }

  try {
    const backlog = await readOrderEmailBacklog(deps.store, ORDER_EMAIL_OPS_LIMITS.backlogAgeSeconds);
    if (backlog.length > 0) {
      result.backlogAlerted = await sendOnce(deps, 'order_email_backlog', orderEmailBacklogMail(backlog));
    }
  } catch (error) {
    result.failedChecks.push('backlog');
    logFailure('backlog', error);
  }

  try {
    const { emails, total } = await listUnnotifiedDeadOrderEmails(deps.store, ORDER_EMAIL_OPS_LIMITS.digestLimit);
    if (emails.length > 0 && (await sendOnce(deps, 'order_email_dead', orderEmailDeadDigestMail(emails, total)))) {
      // 印付けに失敗したら、1時間後の点検で同じ分を知らせ直す（知らせを失うより再送を選ぶ）
      result.deadNotified = await markDeadOrderEmailsNotified(deps.store, emails.map((email) => email.id));
    }
  } catch (error) {
    result.failedChecks.push('dead');
    logFailure('dead', error);
  }

  try {
    const { emails, total } = await listUnnotifiedDeliveryProblems(deps.store, ORDER_EMAIL_OPS_LIMITS.digestLimit);
    if (emails.length > 0 && (await sendOnce(deps, 'order_email_delivery_problem', orderEmailDeliveryProblemMail(emails, total)))) {
      result.deliveryNotified = await markDeliveryProblemsNotified(deps.store, emails.map((email) => email.id));
    }
  } catch (error) {
    result.failedChecks.push('delivery');
    logFailure('delivery', error);
  }

  try {
    const lastSucceededAt = (await readHeartbeats(deps.store)).order_email_worker?.lastSucceededAt ?? null;
    if (lastSucceededAt && deps.now().getTime() - lastSucceededAt.getTime() >= ORDER_EMAIL_OPS_LIMITS.staleAfterSeconds * 1000) {
      result.staleAlerted = await sendOnce(deps, 'job_stale_order_email_worker', staleJobMail('order_email_worker', lastSucceededAt));
    }
  } catch (error) {
    result.failedChecks.push('stale');
    logFailure('stale', error);
  }

  return result;
}
