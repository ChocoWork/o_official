import 'server-only';

import { createInviteToken, hashInviteToken } from '@/features/auth/staff/invite-token';
import {
  staffDemoteFailureReason,
  staffInviteActivateFailureReason,
  staffInviteCancelFailureReason,
  staffInviteIssueFailureReason,
  type StaffDemoteReason,
  type StaffInviteActivateReason,
  type StaffInviteCancelReason,
  type StaffInviteIssueReason,
} from '@/lib/auth/staff-passkey-invite-errors';

type RpcOutcome = { data: unknown; error: { code?: string; message?: string } | null };

/** DB の関数を呼ぶ口。呼び手は `createServiceRoleClient()` の戻り（`service_role` だけが招待の関数を呼べる）を渡す。 */
export type StaffInviteDeps = {
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<RpcOutcome>;
};

export type StaffInviteResult<T, R extends string> = { ok: true; value: T } | { ok: false; reason: R };

type Called = { kind: 'ok'; data: unknown } | { kind: 'error'; message: string | undefined } | { kind: 'thrown' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `bytea` は PostgREST に `\x` の16進の文字列で渡す。 */
const toByteaHex = (bytes: Uint8Array): string => `\\x${Buffer.from(bytes).toString('hex')}`;

/**
 * RPC を1回呼ぶ。例外・誤りは分類して返し、例外の本文・合言葉・引数はログに出さない（名前とコードだけ）。
 */
async function call(deps: StaffInviteDeps, name: string, args: Record<string, unknown>): Promise<Called> {
  let outcome: RpcOutcome;
  try {
    outcome = await deps.rpc(name, args);
  } catch {
    console.error('staff-invite-store: rpc call failed', { name });
    return { kind: 'thrown' };
  }
  if (outcome.error) {
    console.error('staff-invite-store: rpc returned an error', { name, code: outcome.error.code });
    return { kind: 'error', message: outcome.error.message };
  }
  return { kind: 'ok', data: outcome.data };
}

/**
 * 招待を出す。合言葉はここで作り、ハッシュだけを DB に渡す（合言葉は戻り値でだけ返し、メールのリンクにだけ使う）。
 * DB は古い招待・鍵・役割の取り消しと新しい行の作成を1つの取引で行う。
 *
 * @impl IMPL-AUTH-357
 * @design DD-AUTH-075
 */
export async function issueStaffInvite(
  deps: StaffInviteDeps,
  input: {
    userId: string;
    roleCode: 'admin' | 'supporter';
    kind: 'invite' | 'redo' | 'promote';
    issuedBy: string;
    reason: string | null;
  },
): Promise<
  StaffInviteResult<{ inviteId: string; token: string }, Exclude<StaffInviteIssueReason, 'kind_forbidden'>>
> {
  const { token, tokenHash } = createInviteToken();
  const called = await call(deps, 'staff_invite_issue', {
    p_user_id: input.userId,
    p_role_code: input.roleCode,
    p_kind: input.kind,
    p_issued_by: input.issuedBy,
    p_reason: input.reason,
    p_token_hash: toByteaHex(tokenHash),
  });
  if (called.kind === 'thrown') return { ok: false, reason: 'failed' };
  if (called.kind === 'error') {
    const reason = staffInviteIssueFailureReason(called.message);
    return { ok: false, reason: reason === 'kind_forbidden' ? 'failed' : reason };
  }
  if (typeof called.data !== 'string' || called.data === '') return { ok: false, reason: 'failed' };
  return { ok: true, value: { inviteId: called.data, token } };
}

/**
 * 合言葉を消費する（使い切りにして、招待の id・利用者・役割を返す。窓は開けない）。
 * 合言葉は呼びの引数にもログにも出さず、ハッシュだけを渡す。無い・期限切れ・使用済み・取り消し済みは `invalid`。
 *
 * @impl IMPL-AUTH-397
 * @design DD-AUTH-075
 */
export async function consumeStaffInvite(
  deps: StaffInviteDeps,
  token: string,
): Promise<StaffInviteResult<{ inviteId: string; userId: string; roleCode: string }, 'invalid'>> {
  const called = await call(deps, 'staff_invite_consume', { p_token_hash: toByteaHex(hashInviteToken(token)) });
  if (called.kind !== 'ok' || !Array.isArray(called.data) || called.data.length !== 1) {
    return { ok: false, reason: 'invalid' };
  }
  const row: unknown = called.data[0];
  if (
    !isRecord(row) || typeof row.invite_id !== 'string' || typeof row.user_id !== 'string'
    || typeof row.role_code !== 'string'
  ) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, value: { inviteId: row.invite_id, userId: row.user_id, roleCode: row.role_code } };
}

/**
 * 消費した招待を、できたセッションに結んで登録の窓を開く。結び済みは `already_bound`。
 *
 * @impl IMPL-AUTH-398
 * @design DD-AUTH-075
 */
export async function bindStaffInviteWindow(
  deps: StaffInviteDeps,
  inviteId: string,
  sessionId: string,
): Promise<StaffInviteResult<void, 'already_bound' | 'failed'>> {
  const called = await call(deps, 'staff_invite_bind_window', { p_invite_id: inviteId, p_session_id: sessionId });
  if (called.kind === 'ok') return { ok: true, value: undefined };
  const reason: StaffInviteActivateReason =
    called.kind === 'error' ? staffInviteActivateFailureReason(called.message) : 'failed';
  return { ok: false, reason: reason === 'already_bound' ? 'already_bound' : 'failed' };
}

/**
 * 2本そろった時に役割を有効にする。鍵がすべて窓の中で認めた鍵で、本数が下限以上かの確かめは DB の関数が行う。
 *
 * @impl IMPL-AUTH-399
 * @design DD-AUTH-075
 */
export async function activateStaffRole(
  deps: StaffInviteDeps,
  userId: string,
  sessionId: string,
): Promise<
  StaffInviteResult<{ role: string }, Exclude<StaffInviteActivateReason, 'already_bound'>>
> {
  const called = await call(deps, 'staff_role_activate', { p_user_id: userId, p_session_id: sessionId });
  if (called.kind === 'thrown') return { ok: false, reason: 'failed' };
  if (called.kind === 'error') {
    const reason = staffInviteActivateFailureReason(called.message);
    return { ok: false, reason: reason === 'already_bound' ? 'failed' : reason };
  }
  if (!isRecord(called.data) || typeof called.data.role !== 'string') return { ok: false, reason: 'failed' };
  return { ok: true, value: { role: called.data.role } };
}

/**
 * 開いている招待を取り消す（操作者が今も有効な店長かは DB が確かめる）。取り消す物が無ければ `cancelled: false`。
 *
 * @impl IMPL-AUTH-400
 * @design DD-AUTH-091
 */
export async function cancelStaffInvite(
  deps: StaffInviteDeps,
  actorId: string,
  userId: string,
): Promise<StaffInviteResult<{ cancelled: boolean }, StaffInviteCancelReason>> {
  const called = await call(deps, 'staff_invite_cancel', { p_actor_id: actorId, p_user_id: userId });
  if (called.kind === 'ok') return { ok: true, value: { cancelled: called.data === true } };
  return { ok: false, reason: called.kind === 'error' ? staffInviteCancelFailureReason(called.message) : 'failed' };
}

/**
 * 店員をお客さんに戻す（降格）。最後の店長・自分自身・店長でない操作者は DB が断る。降格した店長が出した招待も DB が同じ取引で取り消す。
 *
 * @impl IMPL-AUTH-401
 * @design DD-AUTH-085
 */
export async function demoteStaff(
  deps: StaffInviteDeps,
  actorId: string,
  userId: string,
): Promise<StaffInviteResult<void, StaffDemoteReason>> {
  const called = await call(deps, 'staff_demote', { p_actor_id: actorId, p_user_id: userId });
  if (called.kind === 'ok') return { ok: true, value: undefined };
  return { ok: false, reason: called.kind === 'error' ? staffDemoteFailureReason(called.message) : 'failed' };
}

/**
 * その人に開いている招待（取り消し・有効化されておらず、期限内）があるか。誤りは偽（招待中と出さない）。
 *
 * @impl IMPL-AUTH-402
 * @design DD-AUTH-075
 */
export async function hasOpenStaffInvite(deps: StaffInviteDeps, userId: string): Promise<boolean> {
  const called = await call(deps, 'staff_invite_open', { p_user_id: userId });
  return called.kind === 'ok' && called.data === true;
}
