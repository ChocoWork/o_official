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
 */
export async function issueReturnIntent(input: {
  rawNext: unknown;
  purpose: ReturnIntentPurpose;
  origin?: string;
}): Promise<{ action: ReturnIntentCookieAction; outcome: 'created' | 'cleared' | 'rejected' | 'failed' }> {
  try {
    if (input.rawNext === undefined || input.rawNext === null || input.rawNext === '') {
      return { action: { kind: 'clear' }, outcome: 'cleared' };
    }

    const checked = validateReturnPath(input.rawNext, { origin: input.origin });
    if (!checked.ok) {
      await auditSafely('rejected', checked.reason);
      return { action: { kind: 'clear' }, outcome: 'rejected' };
    }

    const created = await createReturnIntent({ returnPath: checked.path, purpose: input.purpose });
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

    const checked = validateReturnPath(stored, {
      origin: input.origin,
      viewer: { role: input.viewer.role, aal: input.viewer.aal },
    });
    if (!checked.ok) {
      await auditSafely('rejected', checked.reason);
      return fallback({ kind: 'clear' });
    }

    return { path: checked.path, needsMfa: false, action: { kind: 'clear' } };
  } catch {
    return fallback({ kind: 'clear' });
  }
}
