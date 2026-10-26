/**
 * 戻り先の控えの開始と解決（src/features/auth/return-intent/return-intent-service.ts）。
 *
 * @packageDocumentation
 * @remarks 入口（ログインを始める POST）で確かめて控え、出口（ログインが確定する所）で使い切って確かめ直す。
 * ログインそのものを止めないため、どの関数も例外を投げず、失敗は既定の行き先と Cookie の動作に倒す。
 * 監査には理由の符号だけを残し、戻り先の道筋・番号・メールは残さない。
 */
import logAudit from '@/lib/audit';
import { clearCookieOptions, cookieOptionsForReturnIntent, returnIntentCookieName } from '@/lib/cookie';
import { isPrivilegedRole, validateReturnPath } from './return-path';
import {
  RETURN_INTENT_TOKEN_PATTERN,
  consumeReturnIntent,
  createReturnIntent,
  type ReturnIntentPurpose,
} from './return-intent-store';

export type ReturnIntentCookieAction =
  | { kind: 'set'; token: string; maxAgeSeconds: number }
  | { kind: 'clear' }
  | { kind: 'keep' };

export type ResolvedDestination = { path: string; needsMfa: boolean; action: ReturnIntentCookieAction };

const AUDIT_ACTION = 'auth.return_intent';
const MFA_PATH = '/auth/verified';
const DEFAULT_RETURN_PATH = '/';

async function auditSafely(outcome: 'rejected' | 'error', detail: string): Promise<void> {
  try {
    await logAudit({ action: AUDIT_ACTION, outcome, detail });
  } catch {
    // 監査の失敗でログインを止めない。
  }
}

function returnIntentCookieValues(cookieHeader: string | null): string[] {
  if (!cookieHeader) return [];
  const values: string[] = [];
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === returnIntentCookieName) {
      values.push(part.slice(index + 1).trim());
    }
  }
  return values;
}

/**
 * 戻り先の Cookie の動作を応答に当てる。
 *
 * @impl IMPL-AUTH-217
 * @design DD-AUTH-034
 * @remarks keep は何もしない。入口と出口のどちらも、残っている古い控えの Cookie を使い回さないために clear を明示できるようにする。
 */
export function applyReturnIntentCookie(
  response: { cookies: { set: (cookie: { name: string; value: string } & Record<string, unknown>) => unknown } },
  action: ReturnIntentCookieAction,
): void {
  if (action.kind === 'set') {
    response.cookies.set({
      name: returnIntentCookieName,
      value: action.token,
      ...cookieOptionsForReturnIntent(action.maxAgeSeconds),
    });
  } else if (action.kind === 'clear') {
    response.cookies.set({ name: returnIntentCookieName, value: '', ...clearCookieOptions() });
  }
}

/**
 * Cookie の見出しから戻り先の番号を読む。形が合う 1 つだけを返し、それ以外は null。
 *
 * @impl IMPL-AUTH-218
 * @design DD-AUTH-034
 * @remarks 名前が重なる Cookie はどちらが本物か決められないので、使わずに null にする。
 */
export function readReturnIntentToken(cookieHeader: string | null): string | null {
  const values = returnIntentCookieValues(cookieHeader);
  if (values.length !== 1) return null;
  return RETURN_INTENT_TOKEN_PATTERN.test(values[0]) ? values[0] : null;
}

/**
 * ログインを始める POST で、戻り先を確かめて控える。
 *
 * @impl IMPL-AUTH-208
 * @design DD-AUTH-034
 * @remarks 戻り先が無い・不正・保存の失敗でも、前の試みの古い Cookie が残って使われないよう必ず clear を返す。
 * alwaysCreate（登録の確認リンクの結び付け用）が真の時は、戻り先が無い・不正でも既定の '/' で控えを作る
 * （控えの有無で登録済みかどうかが分からないようにするため。不正の理由の監査は残す）。
 * bindTo には登録したメールを渡し、番号とメールを一緒にハッシュした控えにする（SEC-AUTH-007、ADR-0413）。
 */
export async function issueReturnIntent(input: {
  rawNext: unknown;
  purpose: ReturnIntentPurpose;
  origin?: string;
  bindTo?: string;
  alwaysCreate?: boolean;
}): Promise<{ action: ReturnIntentCookieAction; outcome: 'created' | 'cleared' | 'rejected' | 'failed' }> {
  try {
    let returnPath = DEFAULT_RETURN_PATH;

    if (input.rawNext === undefined || input.rawNext === null || input.rawNext === '') {
      if (!input.alwaysCreate) return { action: { kind: 'clear' }, outcome: 'cleared' };
    } else {
      const checked = validateReturnPath(input.rawNext, { origin: input.origin });
      if (checked.ok) {
        returnPath = checked.path;
      } else {
        await auditSafely('rejected', checked.reason);
        if (!input.alwaysCreate) return { action: { kind: 'clear' }, outcome: 'rejected' };
      }
    }

    const created = await createReturnIntent({
      returnPath,
      purpose: input.purpose,
      ...(input.bindTo === undefined ? {} : { bindTo: input.bindTo }),
    });
    if (!created) {
      await auditSafely('error', 'create_failed');
      return { action: { kind: 'clear' }, outcome: 'failed' };
    }

    return {
      action: { kind: 'set', token: created.token, maxAgeSeconds: created.maxAgeSeconds },
      outcome: 'created',
    };
  } catch {
    return { action: { kind: 'clear' }, outcome: 'failed' };
  }
}

/**
 * ログインが確定する所で、控えを使い切って行き先を決める。
 *
 * @impl IMPL-AUTH-216
 * @design DD-AUTH-034
 * @remarks 管理者・サポーターは aal2 になるまで使い切らず、2 段目の後の戻り先を残す。
 * 使い切った値は DB の制約を信用せず、役割と aal2 を含めて出口の確かめをもう一度通す。
 */
export async function resolveReturnDestination(input: {
  cookieHeader: string | null;
  purpose: ReturnIntentPurpose;
  viewer: { id: string; role: 'admin' | 'supporter' | 'user'; aal: string | null };
  origin?: string;
}): Promise<ResolvedDestination> {
  const privileged = isPrivilegedRole(input.viewer.role);
  const defaultPath = privileged ? '/admin' : '/';

  if (privileged && input.viewer.aal !== 'aal2') {
    return { path: MFA_PATH, needsMfa: true, action: { kind: 'keep' } };
  }

  const fallback = (action: ReturnIntentCookieAction): ResolvedDestination => ({
    path: defaultPath,
    needsMfa: false,
    action,
  });

  try {
    if (returnIntentCookieValues(input.cookieHeader).length === 0) {
      return fallback({ kind: 'keep' });
    }

    const token = readReturnIntentToken(input.cookieHeader);
    if (!token) {
      return fallback({ kind: 'clear' });
    }

    const stored = await consumeReturnIntent({ token, purpose: input.purpose, userId: input.viewer.id });
    if (stored === null) {
      return fallback({ kind: 'clear' });
    }

    return await resolveStoredDestination({ stored, viewer: input.viewer, origin: input.origin });
  } catch {
    return fallback({ kind: 'clear' });
  }
}

/**
 * 使い切った戻り先の値を、出口の確かめ（役割と aal2 を含む）にもう一度通す。
 *
 * @impl IMPL-AUTH-221
 * @design DD-AUTH-034
 * @remarks DB の制約を信用せず、使い切った値を必ず確かめ直す。外れた時は既定の行き先に倒して控えの Cookie を消す。
 * 管理者・サポーターが aal2 でない場合の判断（2 段目へ送る）はここで持たず、呼び出し側が先に決める。
 * 外れた理由の符号だけを監査に残し、道筋は残さない。
 */
export async function resolveStoredDestination(input: {
  stored: string;
  viewer: { role: 'admin' | 'supporter' | 'user'; aal: string | null };
  origin?: string;
}): Promise<ResolvedDestination> {
  const checked = validateReturnPath(input.stored, {
    origin: input.origin,
    viewer: { role: input.viewer.role, aal: input.viewer.aal },
  });
  if (!checked.ok) {
    await auditSafely('rejected', checked.reason);
    return {
      path: isPrivilegedRole(input.viewer.role) ? '/admin' : DEFAULT_RETURN_PATH,
      needsMfa: false,
      action: { kind: 'clear' },
    };
  }
  return { path: checked.path, needsMfa: false, action: { kind: 'clear' } };
}

/**
 * 登録の確認リンクを、登録を始めたブラウザで開いたかを確かめて控えを使い切る。
 *
 * @impl IMPL-AUTH-220
 * @design DD-AUTH-034
 * @remarks Cookie の番号と、確認した利用者のメールを一緒にハッシュした印が signup の未使用の行に当たった時だけ bound を返す
 * （番号だけが当たる形では、被害者の有効な Cookie が攻撃者の印で通る。ADR-0413）。
 * session を作る前に呼ぶ。Cookie は触らず、DB を呼ぶのは番号が 1 つで形が合う時だけ。例外は投げない。
 */
export async function consumeSignupBinding(input: {
  cookieHeader: string | null;
  email: string;
  userId: string;
}): Promise<{ bound: true; storedPath: string } | { bound: false }> {
  try {
    const token = readReturnIntentToken(input.cookieHeader);
    if (!token || !input.email) return { bound: false };
    const stored = await consumeReturnIntent({
      token,
      purpose: 'signup',
      userId: input.userId,
      bindTo: input.email,
    });
    return stored === null ? { bound: false } : { bound: true, storedPath: stored };
  } catch {
    return { bound: false };
  }
}
