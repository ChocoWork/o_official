import { sendMail } from '@/lib/mail';
import { logAudit } from '@/lib/audit';
import { toOrderNumber } from '@/lib/orders/order-number';
import { formatCurrency } from '@/lib/orders/order-confirmation-email';
import type { BacklogRow, DeadEvent, RecoveredReviewReason } from '@/lib/ops/ops-store';
import type { WebhookFailureCause } from '@/lib/stripe/webhook-events';
import type { StripeReconciliationError, UnmatchedRecentPayment } from '@/lib/stripe/reconcile-orders';

/**
 * 店への知らせのメール（設計書 2026-10-05 グループ B の第6章）。
 * 宛先は SHOP_ALERT_EMAIL（今の要対応のメールと同じ）。お客様の名前・住所・メールアドレスは入れない。
 */
export type OpsAlertKind =
  | 'webhook_backlog'
  | 'webhook_dead'
  | 'job_stale'
  | 'webhook_signature_invalid'
  | 'webhook_mode_mismatch'
  | 'orders_recovered_from_payment'
  | 'reconcile_findings';

export type OpsAlertMail = { kind: OpsAlertKind; subject: string; lines: string[] };

export type RecoveredOrderSummary = {
  orderId: string;
  /** null は、注文は作ったが要確認の印を付けられなかったこと */
  reviewReason: RecoveredReviewReason | null;
  totalAmount: number | null;
  currency: string | null;
};

const RUNBOOK = '手順書（docs/06_Operations/webhook-queue-operations.md）';

const STATUS_LABELS: Record<BacklogRow['status'], string> = {
  queued: '処理待ち',
  processing: '処理中',
  failed: 'やり直し待ち',
};

const FAILURE_CAUSES: readonly WebhookFailureCause[] = [
  'stripe_unavailable',
  'db_unavailable',
  'not_converged',
  'lease_expired',
  'invalid_payload',
  'unexpected_error',
];

const STALE_JOBS = {
  order_sweep: { label: '毎時の見回り', hours: 2 },
  stripe_reconcile: { label: '毎晩の照合', hours: 25 },
} as const;

function formatJst(date: Date): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatAmount(amount: number | null, currency: string | null): string {
  if (amount === null || !currency) return '金額不明';
  return formatCurrency(amount, currency);
}

function formatCause(cause: string | null): WebhookFailureCause {
  const code = cause ?? 'unexpected_error';
  return FAILURE_CAUSES.find((allowedCause) => allowedCause === code) ?? 'unexpected_error';
}

export function backlogAlertMail(rows: BacklogRow[]): OpsAlertMail {
  return {
    kind: 'webhook_backlog',
    subject: '【要確認】Stripe の知らせの処理が遅れています',
    lines: [
      '受け取ってから15分以上たっても、処理が終わっていない Stripe の知らせがあります。',
      '',
      ...rows.map((row) => {
        const causes = row.lastErrors.length > 0 ? ` 原因: ${row.lastErrors.map(formatCause).join('、')}` : '';
        return `${STATUS_LABELS[row.status]}: ${row.count}件（いちばん古い受け取り: ${formatJst(row.oldestReceivedAt)}）${causes}`;
      }),
      '',
      `次にやること: ${RUNBOOK}の「知らせが溜まったとき」に沿って、定期処理（worker）が動いているかを確かめてください。`,
    ],
  };
}

export function deadDigestMail(events: DeadEvent[], total: number): OpsAlertMail {
  const rest = total - events.length;
  return {
    kind: 'webhook_dead',
    subject: `【要対応】処理を止めた Stripe の知らせ（${total}件）`,
    lines: [
      '8回やり直しても処理できなかった Stripe の知らせを退避しました（これ以上やり直しません）。',
      '',
      ...events.map((event) =>
        `- ${event.eventId}（${event.eventType}） 原因: ${formatCause(event.cause)} `
        + `受け取り: ${formatJst(event.receivedAt)} 試行: ${event.attemptCount}回`),
      ...(rest > 0 ? [`（ほかに ${rest} 件。次の知らせで送ります）`] : []),
      '',
      '注文の状態は毎時の見回りが、返金と会計は毎晩の照合が Stripe に合わせます。ただし、見回りが注文を作るのは、直近24時間の Checkout Session の支払いだけです。',
      'それより古い、注文の無い支払いは、直近7日の分を毎晩の照合のメールでお知らせします。',
      `同じ原因が続くときは、${RUNBOOK}の「退避の知らせが来たとき」に沿って開発者に連絡してください。`,
    ],
  };
}

export function staleJobMail(job: keyof typeof STALE_JOBS, lastSucceededAt: Date): OpsAlertMail {
  const { label, hours } = STALE_JOBS[job];
  return {
    kind: 'job_stale',
    subject: `【要確認】定期処理が止まっています（${label}）`,
    lines: [
      `${label}が、${hours}時間以上成功していません。`,
      `最後の成功: ${formatJst(lastSucceededAt)}`,
      '',
      `次にやること: ${RUNBOOK}の「定期処理が止まったとき」に沿って、定期処理の実行の記録を確かめてください。`,
    ],
  };
}

export function signatureAlertMail(count: number): OpsAlertMail {
  return {
    kind: 'webhook_signature_invalid',
    subject: '【要確認】署名の合わない Stripe の知らせが届いています',
    lines: [
      `10分の間に、署名の合わない知らせが${count}件届きました（すべて断っています）。`,
      '',
      'Stripe の署名の合言葉（STRIPE_WEBHOOK_SECRET）の設定を確かめてください。設定が正しければ、外からの偽の知らせを断っているだけです。',
      `${RUNBOOK}の「署名不正の知らせが来たとき」も確かめてください。`,
    ],
  };
}

export function modeMismatchMail(eventLivemode: boolean, keyLivemode: boolean | null): OpsAlertMail {
  const keyLabel = keyLivemode === null ? '不明' : keyLivemode ? '本番' : 'テスト';
  return {
    kind: 'webhook_mode_mismatch',
    subject: '【要対応】Stripe の本番とテストの知らせが混ざっています',
    lines: [
      `届いた知らせ: ${eventLivemode ? '本番' : 'テスト'}、このアプリの鍵: ${keyLabel}`,
      '',
      'モードの違う知らせは処理していません（この知らせは1時間に1回までなので、続けて届いた分は書いていません）。',
      `Stripe の知らせの宛先と、STRIPE_SECRET_KEY・STRIPE_WEBHOOK_SECRET の組み合わせを確かめてください（${RUNBOOK}の「モード違いの知らせが来たとき」）。`,
    ],
  };
}

export function recoveredOrdersMail(orders: RecoveredOrderSummary[]): OpsAlertMail {
  return {
    kind: 'orders_recovered_from_payment',
    subject: `【要確認】支払いから作った注文（${orders.length}件）`,
    lines: [
      'Stripe に支払いがあったのに注文が無かったため、毎時の見回りが注文を作りました。',
      'お客様には注文確定（またはお支払い待ち）のメールが自動で届いていますが、決済の画面で注文の完了を見ていない可能性があります。注文の内容をお客様へ確認してください。',
      '',
      ...orders.map((order) =>
        `- 注文番号 ${toOrderNumber(order.orderId)} ${formatAmount(order.totalAmount, order.currency)}`
        + (order.reviewReason === 'stock_not_reserved' ? '（在庫も確保できていません）' : '')
        + (order.reviewReason === null ? '（要確認の印を付けられませんでした。管理画面の「要対応・要確認」には出ません）' : '')),
      ...(orders.some((order) => order.reviewReason === 'stock_not_reserved')
        ? ['在庫を確保できていない注文は、先に在庫の手当てをしてください。'] : []),
      '',
      '管理画面の ORDER タブの「要対応・要確認」で、確認したら確認済みにしてください。',
    ],
  };
}

/** 1つの種類につき何行まで書くか。超えた分は「（ほかに N 件）」にまとめる */
const MAX_FINDING_LINES = 20;

function cappedLines(lines: string[]): string[] {
  const rest = lines.length - MAX_FINDING_LINES;
  return rest > 0 ? [...lines.slice(0, MAX_FINDING_LINES), `（ほかに ${rest} 件）`] : lines;
}

/**
 * 毎晩の照合で見つかった、直近7日の注文の無い支払いと、支払い・入金ごとの失敗（設計書 2026-10-05 グループ B の 6）。
 * 書くのは PaymentIntent・入金の ID、金額、支払いの時刻、原因の記号だけ。お客様の名前・住所・メールアドレスは渡されても読まない。
 */
export function reconcileFindingsMail({
  unmatched,
  errors,
}: {
  unmatched: UnmatchedRecentPayment[];
  errors: StripeReconciliationError[];
}): OpsAlertMail {
  return {
    kind: 'reconcile_findings',
    subject: `【要確認】毎晩の照合で注文の無い支払い・失敗が見つかりました（注文なし ${unmatched.length}件・失敗 ${errors.length}件）`,
    lines: [
      '毎晩の照合で、確かめが必要なことが見つかりました。',
      ...(unmatched.length > 0
        ? [
          '',
          '注文の無い支払い（直近7日）: Stripe には成功した支払いがあるのに、注文がありません。お客様は支払い済みで、注文が無い状態です。',
          ...cappedLines(unmatched.map((payment) =>
            `- ${payment.id} ${formatAmount(payment.amount, payment.currency)} 支払い: ${formatJst(new Date(payment.created * 1000))}`)),
        ]
        : []),
      ...(errors.length > 0
        ? [
          '',
          '合わせられなかった支払い・入金: 支払いや入金を Stripe と合わせられませんでした。',
          ...cappedLines(errors.map((error) => `- ${error.sourceId} 原因: ${formatCause(error.reason)}`)),
        ]
        : []),
      '',
      '次にやること: Stripe のダッシュボードで、上の支払い・入金を確かめてください。',
      ...(unmatched.length > 0 ? ['支払い済みで注文が無いときは、お客様に連絡して、注文を作るか返金してください。'] : []),
      `${RUNBOOK}の「照合で見つかったことの知らせが来たとき」に沿って進めてください。`,
    ],
  };
}

export async function sendOpsAlertMail(mail: OpsAlertMail): Promise<boolean> {
  const to = process.env.SHOP_ALERT_EMAIL;
  if (!to || !process.env.MAIL_FROM_ADDRESS) {
    console.warn('[ops-alert] SHOP_ALERT_EMAIL or MAIL_FROM_ADDRESS is not configured');
    return false;
  }
  try {
    await sendMail({ to, subject: mail.subject, text: mail.lines.join('\n') });
    return true;
  } catch (error) {
    console.warn('[ops-alert] send failed', error instanceof Error ? error.name : 'UnknownError');
    await logAudit({
      action: 'ops.alert_mail',
      outcome: 'error',
      resource: 'ops_alert',
      detail: 'mail_send_failed',
      metadata: { kind: mail.kind },
    });
    return false;
  }
}
