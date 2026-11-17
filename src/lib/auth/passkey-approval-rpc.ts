import { createServiceRoleClient } from '@/lib/supabase/server';

/** 呼び出しの結果。誤り・例外は `{ ok: false }` で、呼び手が 503 などの閉じる側に倒す。 */
export type RpcResult<T> = { ok: true; value: T } | { ok: false };

export type ApproveVia = 'window' | 'reauth' | 'script';

/** `window` の上限超え（55000）は `window_full`、古い行（23505）は `stale`、それ以外は `other`。 */
export type ApproveResult = { ok: true } | { ok: false; reason: 'stale' | 'window_full' | 'other' };

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

type RpcOutcome = { data: unknown; error: { code?: string } | null };

async function callRpc(name: string, args: Record<string, unknown>): Promise<RpcOutcome | null> {
  try {
    const service = await createServiceRoleClient();
    return (await service.rpc(name, args)) as RpcOutcome;
  } catch {
    console.error('passkey-approval-rpc: rpc call failed', { name });
    return null;
  }
}

async function callChecked<T>(
  name: string,
  args: Record<string, unknown>,
  accept: (data: unknown) => data is T,
): Promise<RpcResult<T>> {
  const outcome = await callRpc(name, args);
  if (!outcome) return { ok: false };
  if (outcome.error) {
    console.error('passkey-approval-rpc: rpc returned an error', { name, code: outcome.error.code });
    return { ok: false };
  }
  return accept(outcome.data) ? { ok: true, value: outcome.data } : { ok: false };
}

const isBoolean = (data: unknown): data is boolean => typeof data === 'boolean';
const isCount = (data: unknown): data is number => typeof data === 'number' && Number.isInteger(data) && data >= 0;
const isStringArray = (data: unknown): data is string[] =>
  Array.isArray(data) && data.every((item) => typeof item === 'string');

/**
 * 店員（admin・supporter の有効で期限内の役割がある利用者）かを DB で確かめる。
 *
 * @remarks 店員の定義は GoTrue のフック `passkey_access_token_hook` と同じ（DB の関数 `passkey_is_staff`）。
 */
function isStaff(userId: string): Promise<RpcResult<boolean>> {
  return callChecked('passkey_is_staff', { p_user_id: userId }, isBoolean);
}

/**
 * 届いた鍵（応答の `rawId`。base64url）が、その利用者の認めた鍵かを DB で確かめる。
 *
 * @impl IMPL-AUTH-249
 * @design DD-AUTH-050
 * @remarks base64url の確かめは `Buffer.from` に任せない（不正な文字を黙って捨てるため）。形が合わない・空・長さが4で割って1余る
 * （base64url にならない）文字列は RPC を呼ばず偽を返す。直した生の鍵の ID は `\x` の16進の文字列で渡す（PostgREST の `bytea`）。
 */
export async function isCredentialApproved(userId: string, rawIdBase64Url: string): Promise<RpcResult<boolean>> {
  if (!BASE64URL_PATTERN.test(rawIdBase64Url) || rawIdBase64Url.length % 4 === 1) {
    return { ok: true, value: false };
  }
  const hex = Buffer.from(rawIdBase64Url, 'base64url').toString('hex');
  return callChecked('passkey_credential_is_approved', { p_user_id: userId, p_credential_id: `\\x${hex}` }, isBoolean);
}

/**
 * 認めた鍵の `passkey_id` の一覧。
 */
function approvedIds(userId: string): Promise<RpcResult<string[]>> {
  return callChecked('passkey_approved_ids', { p_user_id: userId }, isStringArray);
}

/**
 * 認めた鍵の本数（鍵が実在し、`credential_id` が合う分だけ）。
 */
function approvedCount(userId: string): Promise<RpcResult<number>> {
  return callChecked('passkey_approved_count', { p_user_id: userId }, isCount);
}

/**
 * その利用者・そのセッションの登録の窓が今も開いているか。
 */
function windowIsOpen(userId: string, sessionId: string): Promise<RpcResult<boolean>> {
  return callChecked('passkey_window_is_open', { p_user_id: userId, p_session_id: sessionId }, isBoolean);
}

/**
 * 鍵を認める（`passkey_approve`）。
 *
 * @remarks `23505`（古い行。SEC-AUTH-041）は `stale`、`55000`（窓で認められる上限）は `window_full`、そのほかは `other`。
 */
async function approve(userId: string, passkeyId: string, via: ApproveVia): Promise<ApproveResult> {
  const outcome = await callRpc('passkey_approve', { p_user_id: userId, p_passkey_id: passkeyId, p_via: via });
  if (!outcome) return { ok: false, reason: 'other' };
  if (!outcome.error) return { ok: true };
  console.error('passkey-approval-rpc: approve failed', { code: outcome.error.code });
  if (outcome.error.code === '23505') return { ok: false, reason: 'stale' };
  if (outcome.error.code === '55000') return { ok: false, reason: 'window_full' };
  return { ok: false, reason: 'other' };
}

/**
 * 窓口が使う DB の関数の呼び方は、この部品のここから出す（Task 6・7・8 は RPC を直に呼ばない）。
 * 追跡の単位（`@impl IMPL-AUTH-249`・`@design DD-AUTH-050`）は、中心の `isCredentialApproved` に付け、ほかの5つは同じ部品の一部として
 * 一覧でまとめて出す。
 */
export { isStaff, approvedIds, approvedCount, windowIsOpen, approve };
