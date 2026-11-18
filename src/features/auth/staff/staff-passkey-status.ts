import { clientFetch } from '@/lib/client-fetch';
import type { ListedPasskey, ManageFailureReason } from '@/features/auth/passkey/passkey-client';

/** 店員の一覧の1行。`approved` は、DB の認めた鍵の表にある鍵かどうか（認めていない鍵ではログインできない）。 */
export type StaffListedPasskey = ListedPasskey & { approved: boolean };

export type StaffKeyStatus =
  | { ok: true; isStaff: boolean; approvedCount: number; passkeys: StaffListedPasskey[] }
  | { ok: false; reason: ManageFailureReason };

function failureOf(status: number): ManageFailureReason {
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'unavailable';
  return 'failed';
}

/**
 * 自分のパスキーの一覧と、店員の認めた鍵の本数を窓口（`GET /api/auth/passkey`）から読む。
 *
 * @impl IMPL-AUTH-388
 * @design DD-AUTH-082
 * @remarks 段2の `listPasskeys` が捨てる `approved`・`approvedCount`・`isStaff` を読む。画面が「消すと下限を割る」を窓口と同じ数え方で止めるためと、
 * `/auth/verified` が認めた鍵が1本の店員を見分けるために使う（JWT の印 `staff_passkeys_ok` は真偽しかないので使わない）。
 * 本文は読み切る・捨てる（no-store の応答を読まないと E2E の networkidle が来ない）。形の違う応答は `failed`。
 */
export async function loadStaffPasskeys(fetchApi: typeof clientFetch = clientFetch): Promise<StaffKeyStatus> {
  let response: Response;
  try {
    response = await fetchApi('/api/auth/passkey', { method: 'GET' });
  } catch {
    return { ok: false, reason: 'failed' };
  }
  if (!response.ok) {
    try {
      await response.arrayBuffer();
    } catch {
      // 本文を捨てるだけ。読めなくても失敗の理由は変わらない。
    }
    return { ok: false, reason: failureOf(response.status) };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: 'failed' };
  }
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  if (!record || !Array.isArray(record.passkeys)) return { ok: false, reason: 'failed' };
  const passkeys: StaffListedPasskey[] = [];
  for (const entry of record.passkeys as unknown[]) {
    const item = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
    if (!item || typeof item.id !== 'string' || typeof item.created_at !== 'string') return { ok: false, reason: 'failed' };
    passkeys.push({
      id: item.id,
      friendly_name: typeof item.friendly_name === 'string' ? item.friendly_name : null,
      created_at: item.created_at,
      last_used_at: typeof item.last_used_at === 'string' ? item.last_used_at : null,
      approved: item.approved === true,
    });
  }
  const approvedCount =
    typeof record.approvedCount === 'number' && Number.isInteger(record.approvedCount) && record.approvedCount >= 0 ? record.approvedCount : 0;
  return { ok: true, isStaff: record.isStaff === true, approvedCount, passkeys };
}
