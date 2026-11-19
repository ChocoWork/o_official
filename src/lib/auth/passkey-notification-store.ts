import { createServiceRoleClient } from '@/lib/supabase/server';
import type { RpcResult } from '@/lib/auth/passkey-approval-rpc';

/** 取り出した知らせの1行。`leaseToken` は、完了・失敗・飛ばしの時に担当の印として戻す。 */
export type ClaimedPasskeyNotification = {
  id: string;
  seq: number;
  userId: string;
  kind: 'passkey_added' | 'passkey_removed' | 'passkey_key_replaced';
  passkeyId: string | null;
  friendlyName: string | null;
  subjectIsStaff: boolean;
  notifySubject: boolean;
  subjectEmail: string | null;
  /** 店長への知らせ（やり直し・招待・降格）で、操作した店長のアドレス。ほかの知らせでは null。 */
  actorEmail: string | null;
  occurredAt: string;
  attempts: number;
  leaseToken: string;
};

export type PasskeyNotificationAudience = 'subject_customer' | 'subject_staff' | 'admin';

export type PasskeyNotificationRecipient = { email: string; audience: PasskeyNotificationAudience };

type RpcOutcome = { data: unknown; error: { code?: string } | null };

const KINDS = ['passkey_added', 'passkey_removed', 'passkey_key_replaced'];
const AUDIENCES = ['subject_customer', 'subject_staff', 'admin'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';

async function callChecked<T>(
  name: string,
  args: Record<string, unknown>,
  parse: (data: unknown) => T | undefined,
): Promise<RpcResult<T>> {
  let outcome: RpcOutcome;
  try {
    const service = await createServiceRoleClient();
    outcome = (await service.rpc(name, args)) as RpcOutcome;
  } catch {
    console.error('passkey-notification-store: rpc call failed', { name });
    return { ok: false };
  }
  if (outcome.error) {
    console.error('passkey-notification-store: rpc returned an error', { name, code: outcome.error.code });
    return { ok: false };
  }
  const value = parse(outcome.data);
  return value === undefined ? { ok: false } : { ok: true, value };
}

function parseClaimed(data: unknown): ClaimedPasskeyNotification | null | undefined {
  if (!Array.isArray(data)) return undefined;
  if (data.length === 0) return null;
  const row = data[0];
  if (data.length !== 1 || !isRecord(row)) return undefined;
  const seq = typeof row.seq === 'string' ? Number(row.seq) : row.seq;
  if (
    typeof row.id !== 'string' || typeof seq !== 'number' || !Number.isSafeInteger(seq)
    || typeof row.user_id !== 'string' || typeof row.kind !== 'string' || !KINDS.includes(row.kind)
    || !isNullableString(row.passkey_id) || !isNullableString(row.friendly_name)
    || typeof row.subject_is_staff !== 'boolean' || typeof row.notify_subject !== 'boolean'
    || !isNullableString(row.subject_email) || typeof row.occurred_at !== 'string'
    || !isNullableString(row.actor_email)
    || typeof row.attempts !== 'number' || typeof row.lease_token !== 'string'
  ) {
    return undefined;
  }
  return {
    id: row.id,
    seq,
    userId: row.user_id,
    kind: row.kind as ClaimedPasskeyNotification['kind'],
    passkeyId: row.passkey_id,
    friendlyName: row.friendly_name,
    subjectIsStaff: row.subject_is_staff,
    notifySubject: row.notify_subject,
    subjectEmail: row.subject_email,
    actorEmail: row.actor_email,
    occurredAt: row.occurred_at,
    attempts: row.attempts,
    leaseToken: row.lease_token,
  };
}

function parseRecipients(data: unknown): PasskeyNotificationRecipient[] | undefined {
  if (!Array.isArray(data)) return undefined;
  const out: PasskeyNotificationRecipient[] = [];
  for (const row of data) {
    if (!isRecord(row) || typeof row.email !== 'string' || typeof row.audience !== 'string' || !AUDIENCES.includes(row.audience)) {
      return undefined;
    }
    out.push({ email: row.email, audience: row.audience as PasskeyNotificationAudience });
  }
  return out;
}

const isBoolean = (data: unknown): boolean | undefined => (typeof data === 'boolean' ? data : undefined);

/**
 * 送る順（`seq`）で一番古い、時刻が来た知らせを1行取り出して担当（`sending`）にする。無ければ `null`。
 *
 * @remarks 期限切れの担当は DB の関数が先に戻す。DB の誤り・形の違う戻りは `{ ok: false }`（呼び手は何もせず次の回へ）。
 *
 * @impl IMPL-AUTH-330
 * @design DD-AUTH-086
 */
export function claimPasskeyNotification(leaseSeconds: number): Promise<RpcResult<ClaimedPasskeyNotification | null>> {
  return callChecked('claim_passkey_notification', { _lease_seconds: leaseSeconds }, parseClaimed);
}

/**
 * 送れた行を `sent` にする。担当の印が合わなければ `false`（行は変わらない）。
 *
 * @impl IMPL-AUTH-331
 * @design DD-AUTH-066
 */
export function completePasskeyNotification(id: string, leaseToken: string): Promise<RpcResult<boolean>> {
  return callChecked('complete_passkey_notification', { _id: id, _lease_token: leaseToken }, isBoolean);
}

/**
 * 送れなかった行を再試行に回す（9回目なら `dead`）。`countAttempt` が偽なら回数を数えず（`attempts` を戻し）、次に取り出せる時刻を「今＋900秒以上かつ共有の一時停止の次に試す時刻より後」にして戻す（送り手の設定の失敗）。`errorCode` は小文字・数字・`_` の1〜64字（本文・宛先を入れない）。
 *
 * @impl IMPL-AUTH-332
 * @design DD-AUTH-066
 */
export function failPasskeyNotification(
  id: string,
  leaseToken: string,
  errorCode: string,
  retryAfterSeconds: number,
  countAttempt = true,
): Promise<RpcResult<boolean>> {
  return callChecked(
    'fail_passkey_notification',
    {
      _id: id, _lease_token: leaseToken, _error_code: errorCode, _retry_after_seconds: retryAfterSeconds,
      // 送り手の設定の失敗（上限・鍵・送り元）は、この行の失敗として数えない（偽の時だけ渡す）
      ...(countAttempt ? {} : { _count_attempt: false }),
    },
    isBoolean,
  );
}

/**
 * 宛先が無い行を `skipped` にする。`reason` の形は `errorCode` と同じ。
 *
 * @impl IMPL-AUTH-333
 * @design DD-AUTH-066
 */
export function skipPasskeyNotification(id: string, leaseToken: string, reason: string): Promise<RpcResult<boolean>> {
  return callChecked('skip_passkey_notification', { _id: id, _lease_token: leaseToken, _reason: reason }, isBoolean);
}

/**
 * 行の宛先（本人が先、次に有効な店長）。メールが空の宛先は DB が返さない。
 *
 * @impl IMPL-AUTH-334
 * @design DD-AUTH-066
 */
export function passkeyNotificationRecipients(id: string): Promise<RpcResult<PasskeyNotificationRecipient[]>> {
  return callChecked('passkey_notification_recipients', { _id: id }, parseRecipients);
}
