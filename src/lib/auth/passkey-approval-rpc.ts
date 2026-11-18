import { createServiceRoleClient } from '@/lib/supabase/server';

/** 呼び出しの結果。誤り・例外は `{ ok: false }` で、呼び手が 503 などの閉じる側に倒す。 */
export type RpcResult<T> = { ok: true; value: T } | { ok: false };

export type ApproveVia = 'window' | 'reauth' | 'script';

/** `window` の上限超え（55000）は `window_full`、古い行（23505）は `stale`、認めた鍵が0本の `reauth` の断り（42501）は `reauth_not_allowed`、それ以外は `other`。 */
export type ApproveResult = { ok: true } | { ok: false; reason: 'stale' | 'window_full' | 'reauth_not_allowed' | 'other' };

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

type RpcOutcome = { data: unknown; error: { code?: string; message?: string } | null };

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
 * @remarks 店員の定義は GoTrue のフック `passkey_access_token_hook` と同じ（DB の関数 `passkey_is_staff`）。DB の誤りは偽にせず、`{ ok: false }`（閉じる側）で返す。
 *
 * @impl IMPL-AUTH-266
 * @design DD-AUTH-050
 */
export function isStaff(userId: string): Promise<RpcResult<boolean>> {
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
 *
 * @impl IMPL-AUTH-267
 * @design DD-AUTH-050
 */
export function approvedIds(userId: string): Promise<RpcResult<string[]>> {
  return callChecked('passkey_approved_ids', { p_user_id: userId }, isStringArray);
}

/**
 * 認めた鍵の本数（鍵が実在し、`credential_id` が合う分だけ）。
 *
 * @impl IMPL-AUTH-268
 * @design DD-AUTH-050
 */
export function approvedCount(userId: string): Promise<RpcResult<number>> {
  return callChecked('passkey_approved_count', { p_user_id: userId }, isCount);
}

/**
 * その利用者・そのセッションの登録の窓が今も開いているか。
 *
 * @impl IMPL-AUTH-269
 * @design DD-AUTH-050
 */
export function windowIsOpen(userId: string, sessionId: string): Promise<RpcResult<boolean>> {
  return callChecked('passkey_window_is_open', { p_user_id: userId, p_session_id: sessionId }, isBoolean);
}

/**
 * `passkey_approve` の失敗を理由に直す。`23505` は `stale`、`55000` は `window_full`、`42501` で `PASSKEY_REAUTH_NOT_ALLOWED`
 * （認めた鍵が0本の店員の `reauth`）は `reauth_not_allowed`、そのほかは `other`。
 *
 * @impl IMPL-AUTH-339
 * @design DD-AUTH-069
 */
export function approveFailureReason(code?: string, message?: string): Extract<ApproveResult, { ok: false }>['reason'] {
  if (code === '23505') return 'stale';
  if (code === '55000') return 'window_full';
  if (code === '42501' && message === 'PASSKEY_REAUTH_NOT_ALLOWED') return 'reauth_not_allowed';
  return 'other';
}

/**
 * 鍵を認める（`passkey_approve`）。
 *
 * @remarks `23505`（古い行。SEC-AUTH-041）は `stale`、`55000`（窓で認められる上限）は `window_full`、そのほかは `other`。
 *
 * @impl IMPL-AUTH-270
 * @design DD-AUTH-050
 */
export async function approve(userId: string, passkeyId: string, via: ApproveVia): Promise<ApproveResult> {
  const outcome = await callRpc('passkey_approve', { p_user_id: userId, p_passkey_id: passkeyId, p_via: via });
  if (!outcome) return { ok: false, reason: 'other' };
  if (!outcome.error) return { ok: true };
  console.error('passkey-approval-rpc: approve failed', { code: outcome.error.code });
  return { ok: false, reason: approveFailureReason(outcome.error.code, outcome.error.message) };
}
