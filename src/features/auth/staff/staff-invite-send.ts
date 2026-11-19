import 'server-only';

import { composeInviteMail } from '@/features/auth/staff/invite-mail';
import { buildInviteUrl } from '@/features/auth/staff/invite-token';
import { issueStaffInvite, type StaffInviteDeps } from '@/features/auth/staff/staff-invite-store';
import { revokeAllSessionsForUser } from '@/lib/auth/revoke-user-sessions';
import type { StaffInviteIssueReason } from '@/lib/auth/staff-passkey-invite-errors';
import {
  checkOrderEmailSendConfig,
  sendOrderEmailMessage,
  type OrderEmailMessage,
  type OrderEmailSendOutcome,
} from '@/lib/orders/email/order-email-sender';
import { checkSiteUrlForEmail } from '@/lib/site-url-guard';

/** 招待のリンクの有効な長さ。DB の `staff_invite_issue` の既定（86400秒）と同じ。 */
const INVITE_TTL_SECONDS = 86_400;

export type StaffInviteSendInput = {
  userId: string;
  email: string;
  role: 'admin' | 'supporter';
  kind: 'invite' | 'redo' | 'promote';
  issuedBy: string;
  reason: string | null;
  /** `invite` で、その人が既にパスキーを持っていたか（`redo`・`promote` は常に真として扱う） */
  hadPasskeys: boolean;
};

export type StaffInviteSendFailure =
  | Exclude<StaffInviteIssueReason, 'kind_forbidden'>
  | 'config'
  | 'revoke_failed'
  | 'mail_failed';

export type StaffInviteSendDeps = {
  revokeSessions: (userId: string) => Promise<unknown>;
  send: (message: OrderEmailMessage) => Promise<OrderEmailSendOutcome>;
  siteOrigin: () => { ok: true; origin: string } | { ok: false };
  mailConfigError: () => string | null;
  now: () => Date;
};

const realDeps: StaffInviteSendDeps = {
  revokeSessions: revokeAllSessionsForUser,
  send: (message) => sendOrderEmailMessage(message),
  siteOrigin: () => {
    const site = checkSiteUrlForEmail();
    return site.ok ? { ok: true, origin: site.origin } : { ok: false };
  },
  mailConfigError: () => checkOrderEmailSendConfig(),
  now: () => new Date(),
};

/**
 * メールを送れる設定（サイトの住所・送り手）が整っているかを返す。窓口がアカウントを作る前に使う。
 *
 * @impl IMPL-AUTH-425
 * @design DD-AUTH-076
 * @remarks 理由・設定値は返さない（真偽だけ）。`issueAndSendStaffInvite` の発行前の確かめと同じ条件。
 */
export function isStaffInviteMailReady(): boolean {
  return realDeps.siteOrigin().ok && realDeps.mailConfigError() === null;
}

const ROLE_LABELS = { admin: '店長', supporter: 'サポーター' } as const;

const JST_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** `YYYY年M月D日 H:mm（日本時間）`（段2の店員向けの知らせのメールと同じ形） */
function formatJst(date: Date): string {
  const parts: Record<string, string> = {};
  for (const part of JST_PARTS.formatToParts(date)) parts[part.type] = part.value;
  return `${parts.year}年${Number(parts.month)}月${Number(parts.day)}日 ${Number(parts.hour)}:${parts.minute}（日本時間）`;
}

/**
 * 招待を出して、古いログインを終わらせ、招待のメールを送る（招待・上げる・やり直しの共通の流れ）。
 *
 * @impl IMPL-AUTH-358
 * @design DD-AUTH-076
 * @remarks 発行は鍵・認証アプリ・役割を消すので、メールが送れない設定（送り手・サイトの住所）の時は発行の前に断る。
 * リンクの元はサイトの設定の住所だけで、要求の Host・Origin は使わない（リンクの差し替え・パスワードリセットの汚染と同じ攻撃の防ぎ）。
 * 合言葉はメールのリンクにだけ置き、ログ・戻り値の理由には出さない。
 */
export async function issueAndSendStaffInvite(
  store: StaffInviteDeps,
  input: StaffInviteSendInput,
  overrides: Partial<StaffInviteSendDeps> = {},
): Promise<{ ok: true } | { ok: false; reason: StaffInviteSendFailure }> {
  const deps: StaffInviteSendDeps = { ...realDeps, ...overrides };
  const site = deps.siteOrigin();
  if (!site.ok || deps.mailConfigError() !== null) return { ok: false, reason: 'config' };

  const issued = await issueStaffInvite(store, {
    userId: input.userId,
    roleCode: input.role,
    kind: input.kind,
    issuedBy: input.issuedBy,
    reason: input.reason,
  });
  if (!issued.ok) return { ok: false, reason: issued.reason };
  const issuedAt = deps.now();

  try {
    await deps.revokeSessions(input.userId);
  } catch {
    console.error('staff-invite-send: session revocation failed');
    return { ok: false, reason: 'revoke_failed' };
  }

  const mail = composeInviteMail({
    kind: input.kind,
    roleLabel: ROLE_LABELS[input.role],
    url: buildInviteUrl(site.origin, issued.value.token),
    expiresAtJst: formatJst(new Date(issuedAt.getTime() + INVITE_TTL_SECONDS * 1000)),
    passkeysDeleted: input.kind !== 'invite' || input.hadPasskeys,
  });
  let outcome: OrderEmailSendOutcome;
  try {
    outcome = await deps.send({
      to: input.email,
      subject: mail.subject,
      text: mail.text,
      idempotencyKey: `staff-invite/${issued.value.inviteId}`,
    });
  } catch {
    console.error('staff-invite-send: mail send threw');
    return { ok: false, reason: 'mail_failed' };
  }
  if (!outcome.ok) {
    console.error('staff-invite-send: mail send failed', { category: outcome.failure.category, code: outcome.failure.code });
    return { ok: false, reason: 'mail_failed' };
  }
  return { ok: true };
}
