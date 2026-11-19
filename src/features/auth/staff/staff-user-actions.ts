/**
 * 管理画面「ユーザー」の店員の操作（招待・やり直し・お客さんに戻す・招待の取り消し）を送り、結果を店長向けの文にする。
 *
 * @packageDocumentation
 * @remarks 文は窓口の `code`・状態から決め、窓口が返す本文は使わない。無操作の 401（`session_idle`）は `clientFetch` が `/login` へ送る。
 * 503 はログアウトにせず、しばらくしてからのお試しを案内するだけにする。
 */
import { clientFetch } from '@/lib/client-fetch';

export const STAFF_MSG_MAIL_FAILED = 'メールを送れませんでした。もう一度、招待を出してください。';
export const STAFF_MSG_ALREADY_STAFF = 'すでに店員です。やり直しは、一覧の「パスキーを全部消してやり直す」から行ってください。';
export const STAFF_MSG_UNAVAILABLE = 'ただいま処理できません。しばらくしてからお試しください。';
export const STAFF_MSG_LAST_ADMIN = '店長を1人以上残してください。';
export const STAFF_MSG_SELF = '自分自身は変更できません。';
const MSG_FAILED = '処理を完了できませんでした。もう一度お試しください。';

/** 招待まわりの失敗のうち、文が決まっているものだけを返す。それ以外は `null`。 */
function staffInviteFailureMessage(status: number, code: unknown): string | null {
  if (status === 502 || code === 'mail_failed') return STAFF_MSG_MAIL_FAILED;
  if (code === 'already_staff') return STAFF_MSG_ALREADY_STAFF;
  if (status === 503 || status === 429) return STAFF_MSG_UNAVAILABLE;
  return null;
}

/** `cancelled` は招待の取り消しの窓口だけが返す（取り消す物が無かった時は `false`）。 */
export type StaffActionResult = { ok: true; cancelled?: boolean } | { ok: false; message: string; mailFailed?: boolean };

function failureMessage(status: number, code: unknown): string {
  const decided = staffInviteFailureMessage(status, code);
  if (decided) return decided;
  if (code === 'last_admin' || code === 'LAST_ADMIN_REQUIRED') return STAFF_MSG_LAST_ADMIN;
  if (code === 'self' || code === 'SELF_ROLE_CHANGE_FORBIDDEN') return STAFF_MSG_SELF;
  if (code === 'not_staff') return '店員ではありません。';
  if (code === 'not_found') return 'ユーザーが見つかりません。一覧を読み込み直してください。';
  if (status === 400) return '入力を確かめてください。';
  if (status === 401) return '認証が必要です。再ログインしてください。';
  if (status === 403) return 'この操作は店長だけが行えます。';
  return MSG_FAILED;
}

/**
 * 店員の操作の窓口へ POST し、結果を返す。通信の失敗も文にして返す（投げない）。
 *
 * @impl IMPL-AUTH-396
 * @design DD-AUTH-084
 */
export async function postStaffAction(url: string, body?: Record<string, unknown>): Promise<StaffActionResult> {
  try {
    const response = await clientFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const parsed: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const cancelled = typeof parsed === 'object' && parsed !== null ? (parsed as { cancelled?: unknown }).cancelled : undefined;
      return typeof cancelled === 'boolean' ? { ok: true, cancelled } : { ok: true };
    }
    const code = typeof parsed === 'object' && parsed !== null && 'code' in parsed ? (parsed as { code?: unknown }).code : undefined;
    const message = failureMessage(response.status, code);
    // 発行は済んでいて、メールだけが出なかった時（呼び手が一覧を読み直して「招待中」を見せる）。
    return message === STAFF_MSG_MAIL_FAILED ? { ok: false, message, mailFailed: true } : { ok: false, message };
  } catch {
    return { ok: false, message: MSG_FAILED };
  }
}
