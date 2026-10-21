import 'server-only';
import { bumpSignal, claimAlert, releaseAlert, type OpsStore } from '@/lib/ops/ops-store';
import { sendOpsAlertMail, type OpsAlertMail } from '@/lib/ops/ops-alert-mail';

export type DeliveryOpsKind = 'account_error' | 'key_missing' | 'signature_invalid' | 'read_failed' | 'unknown_status';

// 通知には外部の本文・番号・例外文を受け取る入口を作らない。
const MESSAGES: Record<DeliveryOpsKind, { subject: string; line: string }> = {
  account_error: { subject: '配送の追跡の口座を確かめてください', line: '17TRACK の口座全体の失敗がありました。利用枠と鍵の設定を確かめてください。' },
  key_missing: { subject: '配送の追跡の鍵がありません', line: '配送の追跡はオンですが、鍵が無いため処理を止めています。予定は残っています。' },
  signature_invalid: { subject: '配送の追跡の署名が合いません', line: '10分の間に署名の合わない知らせが5件以上届きました。鍵の設定を確かめてください。' },
  read_failed: { subject: '配送の追跡を読み直せません', line: '配送の追跡の読み直しが続けて失敗したか、DB の処理に失敗しました。実行の記録を確かめてください。' },
  unknown_status: { subject: '配送の追跡に未知の状態があります', line: '17TRACK から未知の状態が届きました。状態の対応の表を確かめてください。' },
};

export async function reportDeliveryTrackingIssue(store: OpsStore, kind: DeliveryOpsKind): Promise<void> {
  try {
    const key = `delivery_tracking_${kind}` as const;
    if (kind === 'signature_invalid' && await bumpSignal(store, key, 600) < 5) return;
    const message = MESSAGES[kind];
    const mail: OpsAlertMail = { kind: key, subject: `【要確認】${message.subject}`, lines: [message.line] };
    const claim = await claimAlert(store, key, 86400);
    if (!claim) return;
    let sent = false;
    try { sent = await sendOpsAlertMail(mail); }
    finally { if (!sent) await releaseAlert(store, claim); }
  } catch (error) {
    console.error('[delivery-tracking] issue report failed', error instanceof Error ? error.name : 'UnknownError');
  }
}
