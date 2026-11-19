/**
 * パスキーの足し・消し・差し替えの知らせのメールの文面を作る（テキストだけ。HTML なし）。
 * 宛先の種類（お客さん・店員本人・店長）ごとに文面を分ける。本人のメールのアドレスは、店長あての文面にだけ入れる。
 */

import type { PasskeyNotificationKind } from '@/lib/auth/passkey-notification-store';

export type { PasskeyNotificationKind };
export type PasskeyNotificationComposeAudience = 'subject_customer' | 'subject_staff' | 'admin';

export type PasskeyNotificationComposeInput = {
  kind: PasskeyNotificationKind;
  audience: PasskeyNotificationComposeAudience;
  friendlyName: string | null;
  occurredAt: Date;
  subjectEmail: string | null;
  /** 店長への知らせ（やり直し・招待・降格）で、操作した店長のアドレス。ほかの知らせでは null */
  actorEmail: string | null;
  contactUrl: string;
};

const SHOP_NAME = 'Le Fil des Heures';
const NAME_MAX_LENGTH = 64;
/** 名前に使えない文字: C0・C1 の制御文字と、表示の向きを変える文字（`schemas/passkey.ts` の NAME_FORBIDDEN_CHARS と同じ） */
const FORBIDDEN_CHARS = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const NEWLINES = /[\r\n\u2028\u2029]+/g;

/**
 * 鍵の名前を、メールの1行に収まる形にする。GoTrue を直に叩けば店員が自由に書ける文なので、受け取る側で整える。
 * 改行は空白に替え、制御文字・表示の向きを変える文字を除き、前後の空白を落として64字で切る。空なら「名前なし」。
 *
 * @impl IMPL-AUTH-335
 * @design DD-AUTH-067
 */
export function sanitizePasskeyNameForMail(name: string | null): string {
  if (name === null) return '名前なし';
  const cleaned = Array.from(name.replace(NEWLINES, ' ').replace(FORBIDDEN_CHARS, ''))
    .slice(0, NAME_MAX_LENGTH)
    .join('')
    .trim();
  return cleaned === '' ? '名前なし' : cleaned;
}

const JST_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** `YYYY年M月D日 H:mm（日本時間）` */
function formatJst(date: Date): string {
  const parts: Record<string, string> = {};
  for (const part of JST_PARTS.formatToParts(date)) parts[part.type] = part.value;
  return `${parts.year}年${Number(parts.month)}月${Number(parts.day)}日 ${Number(parts.hour)}:${parts.minute}（日本時間）`;
}

type KeyNoticeKind = 'passkey_added' | 'passkey_removed' | 'passkey_key_replaced';
type StaffNoticeKind = 'staff_redo_issued' | 'staff_invited' | 'staff_demoted';

const STAFF_NOTICE_SUBJECTS: Record<StaffNoticeKind, string> = {
  staff_redo_issued: '店員のパスキーのやり直しが出されました',
  staff_invited: '店員の招待が出されました',
  staff_demoted: '店員がお客さんに戻されました',
};

/** 対象のアドレスが無い時（`subjectEmail` が null）の書き出しも持つ */
const STAFF_NOTICE_LEADS: Record<StaffNoticeKind, (target: string | null) => string> = {
  staff_redo_issued: (target) => (target ? `${target} のパスキーのやり直しが出されました。` : '店員のパスキーのやり直しが出されました。'),
  staff_invited: (target) => (target ? `${target} への店員の招待が出されました。` : '店員の招待が出されました。'),
  staff_demoted: (target) => (target ? `${target} が、店員からお客さんに戻されました。` : '店員が、お客さんに戻されました。'),
};

const STAFF_NOTICE_CLOSING = '心当たりがない場合は、店長の権限を確認してください。';

const CUSTOMER_SUBJECTS: Record<KeyNoticeKind, string> = {
  passkey_added: 'パスキーが追加されました',
  passkey_removed: 'パスキーが削除されました',
  passkey_key_replaced: 'パスキーの内容が変更されました',
};

const ADMIN_SUBJECTS: Record<KeyNoticeKind, string> = {
  passkey_added: '店員のパスキーが追加されました',
  passkey_removed: '店員のパスキーが削除されました',
  passkey_key_replaced: '店員のパスキーの内容が変更されました',
};

const SUBJECT_LEADS: Record<KeyNoticeKind, string> = {
  passkey_added: 'ご登録のアカウントに、パスキーが追加されました。',
  passkey_removed: 'ご登録のアカウントから、パスキーが削除されました。',
  passkey_key_replaced: 'ご登録のアカウントのパスキーの内容が、通常の操作では行われない方法で変更されました。',
};

const CUSTOMER_SELF_LINES: Record<KeyNoticeKind, string> = {
  passkey_added: 'ご自身で追加された場合は、このメールへのご対応は必要ありません。',
  passkey_removed: 'ご自身で削除された場合は、このメールへのご対応は必要ありません。',
  passkey_key_replaced: 'ご自身で変更された場合は、このメールへのご対応は必要ありません。',
};

const ADMIN_LEADS: Record<KeyNoticeKind, string> = {
  passkey_added: 'のパスキーが追加されました。',
  passkey_removed: 'のパスキーが削除されました。',
  passkey_key_replaced: 'のパスキーの内容が変更されました。',
};

/**
 * 店長への知らせ（やり直し・招待・降格）の種類か。これらは `admin` の宛先だけに文面を作る。
 *
 * @impl IMPL-AUTH-408
 * @design DD-AUTH-087
 */
export function isStaffNoticeKind(kind: PasskeyNotificationKind): kind is StaffNoticeKind {
  return kind === 'staff_redo_issued' || kind === 'staff_invited' || kind === 'staff_demoted';
}

/**
 * 知らせのメールの件名と本文を作る。日時は日本時間。`subjectEmail` は `admin` の文面にだけ入れる。
 * 店長への知らせ（やり直し・招待・降格）は `admin` の宛先だけ（ほかは例外）。`名前:` の行は出さず、`操作した店長:`（`actorEmail`）を出す。
 *
 * @impl IMPL-AUTH-336
 * @design DD-AUTH-067
 */
export function composePasskeyNotification(input: PasskeyNotificationComposeInput): { subject: string; text: string } {
  const when = formatJst(input.occurredAt);

  if (isStaffNoticeKind(input.kind)) {
    if (input.audience !== 'admin') throw new Error('staff notice kinds are for admin recipients only');
    // 操作した店長のアドレスは本文にだけ入れる（件名・監査には入れない）
    return {
      subject: STAFF_NOTICE_SUBJECTS[input.kind],
      text: [
        STAFF_NOTICE_LEADS[input.kind](input.subjectEmail),
        '',
        `日時: ${when}`,
        ...(input.actorEmail ? [`操作した店長: ${input.actorEmail}`] : []),
        '',
        STAFF_NOTICE_CLOSING,
      ].join('\n'),
    };
  }

  const name = sanitizePasskeyNameForMail(input.friendlyName);
  const details = [`名前: ${name}`, `日時: ${when}`];

  if (input.audience === 'admin') {
    return {
      subject: ADMIN_SUBJECTS[input.kind],
      text: [
        input.subjectEmail ? `${input.subjectEmail} ${ADMIN_LEADS[input.kind]}` : `店員${ADMIN_LEADS[input.kind]}`,
        '',
        ...details,
        '',
        '本人の操作か確認してください。心当たりがない場合は、そのアカウントのログインを止めてください。',
      ].join('\n'),
    };
  }

  const head = [`${SHOP_NAME} をご利用いただき、ありがとうございます。`, '', SUBJECT_LEADS[input.kind], '', ...details, ''];
  if (input.audience === 'subject_staff') {
    return {
      subject: CUSTOMER_SUBJECTS[input.kind],
      text: [...head, 'ご自身で行われた操作でない場合は、すぐに店長へお知らせください。'].join('\n'),
    };
  }
  return {
    subject: CUSTOMER_SUBJECTS[input.kind],
    text: [
      ...head,
      CUSTOMER_SELF_LINES[input.kind],
      '心当たりがない場合は、お手数ですが、すぐに次のお問い合わせからご連絡ください。',
      input.contactUrl,
    ].join('\n'),
  };
}
