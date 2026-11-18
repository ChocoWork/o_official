/** 招待の DB の関数が投げる文（`error.message`）を、呼び手が分岐に使う理由にする。 */

export type StaffInviteIssueReason =
  | 'kind_forbidden'
  | 'already_staff'
  | 'last_admin'
  | 'self'
  | 'forbidden'
  | 'not_found'
  | 'failed';

export type StaffInviteActivateReason =
  | 'invite_invalid'
  | 'already_bound'
  | 'no_window'
  | 'keys_short'
  | 'keys_not_window'
  | 'failed';

export type StaffInviteCancelReason = 'forbidden' | 'failed';

export type StaffDemoteReason = 'last_admin' | 'self' | 'forbidden' | 'not_found' | 'failed';

export type PasskeyDeleteFloorReason = 'min_keys' | 'not_found' | 'failed';

const ISSUE_REASONS: Readonly<Record<string, StaffInviteIssueReason>> = {
  STAFF_INVITE_KIND_FORBIDDEN: 'kind_forbidden',
  STAFF_ALREADY_STAFF: 'already_staff',
  LAST_ADMIN_REQUIRED: 'last_admin',
  SELF_ROLE_CHANGE_FORBIDDEN: 'self',
  ROLE_PERMISSION_FORBIDDEN: 'forbidden',
  USER_NOT_FOUND: 'not_found',
};

const ACTIVATE_REASONS: Readonly<Record<string, StaffInviteActivateReason>> = {
  STAFF_ACTIVATE_INVITE_INVALID: 'invite_invalid',
  STAFF_INVITE_INVALID: 'invite_invalid',
  STAFF_INVITE_ALREADY_BOUND: 'already_bound',
  STAFF_ACTIVATE_NO_WINDOW: 'no_window',
  STAFF_ACTIVATE_KEYS_SHORT: 'keys_short',
  STAFF_ACTIVATE_KEYS_NOT_WINDOW: 'keys_not_window',
};

const DEMOTE_REASONS: Readonly<Record<string, StaffDemoteReason>> = {
  LAST_ADMIN_REQUIRED: 'last_admin',
  SELF_ROLE_CHANGE_FORBIDDEN: 'self',
  ROLE_PERMISSION_FORBIDDEN: 'forbidden',
  USER_NOT_FOUND: 'not_found',
};

const DELETE_FLOOR_REASONS: Readonly<Record<string, PasskeyDeleteFloorReason>> = {
  STAFF_MIN_KEYS: 'min_keys',
  PASSKEY_NOT_FOUND: 'not_found',
};

function lookup<T extends string>(table: Readonly<Record<string, T>>, message: string | null | undefined): T | undefined {
  if (typeof message !== 'string') return undefined;
  return Object.prototype.hasOwnProperty.call(table, message) ? table[message] : undefined;
}

/**
 * 招待の発行（`staff_invite_issue`）の失敗の文を理由にする。知らない文は `failed`。
 *
 * @impl IMPL-AUTH-340
 * @design DD-AUTH-070
 */
export function staffInviteIssueFailureReason(message: string | null | undefined): StaffInviteIssueReason {
  return lookup(ISSUE_REASONS, message) ?? 'failed';
}

/**
 * 結び（`staff_invite_bind_window`）と役割の有効化（`staff_role_activate`）の失敗の文を理由にする。知らない文は `failed`。
 *
 * @impl IMPL-AUTH-341
 * @design DD-AUTH-071
 */
export function staffInviteActivateFailureReason(message: string | null | undefined): StaffInviteActivateReason {
  return lookup(ACTIVATE_REASONS, message) ?? 'failed';
}

/**
 * 招待の取り消し（`staff_invite_cancel`）の失敗の文を理由にする。操作者が店長でない時だけ `forbidden`、それ以外は `failed`。
 *
 * @impl IMPL-AUTH-342
 * @design DD-AUTH-072
 */
export function staffInviteCancelFailureReason(message: string | null | undefined): StaffInviteCancelReason {
  return message === 'ROLE_PERMISSION_FORBIDDEN' ? 'forbidden' : 'failed';
}

/**
 * 降格（`staff_demote`）の失敗の文を理由にする。知らない文は `failed`。
 *
 * @impl IMPL-AUTH-347
 * @design DD-AUTH-073
 */
export function staffDemoteFailureReason(message: string | null | undefined): StaffDemoteReason {
  return lookup(DEMOTE_REASONS, message) ?? 'failed';
}

/**
 * 役割の変更（`admin_set_user_role`）が、今の店員でない人を店員にしようとして断られたか（`STAFF_INVITE_REQUIRED`）。
 * 真なら窓口は直に変えず、招待の道に落とす。
 *
 * @impl IMPL-AUTH-348
 * @design DD-AUTH-073
 */
export function staffRoleChangeNeedsInvite(message: string | null | undefined): boolean {
  return message === 'STAFF_INVITE_REQUIRED';
}

/**
 * 鍵の削除（`passkey_delete_with_floor`）の失敗の文を理由にする。下限を割る削除は `min_keys`。知らない文は `failed`。
 *
 * @impl IMPL-AUTH-349
 * @design DD-AUTH-073
 */
export function passkeyDeleteFloorFailureReason(message: string | null | undefined): PasskeyDeleteFloorReason {
  return lookup(DELETE_FLOOR_REASONS, message) ?? 'failed';
}
