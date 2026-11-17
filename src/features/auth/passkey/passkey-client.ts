/**
 * 1b のパスキーの窓口を呼ぶ部品（src/features/auth/passkey/passkey-client.ts）。React を知らない純粋な関数だけを置く。
 *
 * @packageDocumentation
 * @remarks `challenge_id`・`credential`・トークンはログに出さない（このファイルは何も出力しない）。
 * 登録・一覧・名前・削除は `clientFetch`（CSRF を付ける）で呼び、ログインの終わりは CSRF の無い窓口なので注入した `fetch` で呼ぶ。
 */
import { clientFetch } from '@/lib/client-fetch';
import type { createPasskeyAuthenticationStarter } from '@/features/auth/passkey/browser-start';
import type { requestAssertion, requestAttestation } from '@/features/auth/passkey/webauthn-browser';

const BASE = '/api/auth/passkey';

export type LoginFailureReason =
  | 'cancelled'
  | 'unsupported'
  | 'rate_limited'
  | 'unavailable'
  | 'captcha_required'
  | 'uv_required'
  | 'not_found'
  | 'staff_blocked'
  | 'failed';

export type LoginResult =
  | { ok: true; user: { id: string; email: string | null; role: string } }
  | { ok: false; reason: LoginFailureReason; retryAfterSeconds?: number };

export type PasskeySummary = { id: string; friendly_name: string | null; created_at: string };

export type RegisterFailureReason =
  | 'cancelled'
  | 'already_registered'
  | 'unsupported'
  | 'reauth_required'
  | 'unauthorized'
  | 'rate_limited'
  | 'retry'
  | 'unavailable'
  | 'failed';

export type RegisterResult =
  | { ok: true; passkey: PasskeySummary; nameApplied: boolean }
  | { ok: false; reason: RegisterFailureReason };

export type ManageFailureReason = 'unauthorized' | 'not_found' | 'rate_limited' | 'unavailable' | 'failed';
export type ManageFailure = { ok: false; reason: ManageFailureReason };

export type ListedPasskey = PasskeySummary & { last_used_at: string | null; approved?: boolean };
export type ListResult =
  | { ok: true; passkeys: ListedPasskey[]; isStaff: boolean; approvedCount?: number }
  | ManageFailure;
export type RenameResult = { ok: true; passkey: { id: string; friendly_name: string } } | ManageFailure;
export type DeleteResult = { ok: true } | ManageFailure;

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function manageFailure(status: number): ManageFailure {
  if (status === 401) return { ok: false, reason: 'unauthorized' };
  if (status === 404) return { ok: false, reason: 'not_found' };
  if (status === 429) return { ok: false, reason: 'rate_limited' };
  if (status === 503) return { ok: false, reason: 'unavailable' };
  return { ok: false, reason: 'failed' };
}

function loginFailureFromFinish(status: number, error: unknown): LoginFailureReason {
  if (status === 401 && error === 'passkey_login_failed') return 'not_found';
  if (status === 400 && error === 'uv_required') return 'uv_required';
  if (status === 403 && (error === 'staff_passkey_required' || error === 'passkey_not_approved')) return 'staff_blocked';
  if (status === 429) return 'rate_limited';
  if (status === 503 || status === 502 || status === 409) return 'unavailable';
  return 'failed';
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  const seconds = Number(value.trim());
  return seconds > 0 ? seconds : undefined;
}

/**
 * パスキーでログインする。始め → 鍵の選択 → 終わりの窓口（`next` を渡す）。
 *
 * @impl IMPL-AUTH-306
 * @design DD-AUTH-060
 */
export async function loginWithPasskey(deps: {
  start: ReturnType<typeof createPasskeyAuthenticationStarter>;
  assert: typeof requestAssertion;
  fetchApp?: typeof fetch;
  next?: string;
  captchaToken?: string;
}): Promise<LoginResult> {
  const started = await deps.start(deps.captchaToken ? { captchaToken: deps.captchaToken } : undefined);
  if (!started.ok) {
    return started.retryAfterSeconds === undefined
      ? { ok: false, reason: started.reason }
      : { ok: false, reason: started.reason, retryAfterSeconds: started.retryAfterSeconds };
  }

  // 始めの部品の型（DOM の型）と WebAuthn の部品の型（supabase-js の型）は同じ形の別の定義。
  const asserted = await deps.assert(started.start.options as unknown as Parameters<typeof requestAssertion>[0]);
  if (!asserted.ok) return { ok: false, reason: asserted.reason === 'already_registered' ? 'failed' : asserted.reason };

  const fetchApp = deps.fetchApp ?? fetch;
  let response: Response;
  try {
    response = await fetchApp(`${BASE}/login/finish`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge_id: started.start.challenge_id,
        credential: asserted.credential,
        ...(deps.next !== undefined ? { next: deps.next } : {}),
      }),
    });
  } catch {
    return { ok: false, reason: 'failed' };
  }

  const body = await readJson(response);
  if (response.ok) {
    const user = body?.user as Record<string, unknown> | undefined;
    if (!user || typeof user.id !== 'string' || user.id.length === 0) return { ok: false, reason: 'failed' };
    return {
      ok: true,
      user: {
        id: user.id,
        email: typeof user.email === 'string' ? user.email : null,
        role: typeof user.role === 'string' ? user.role : 'user',
      },
    };
  }
  const reason = loginFailureFromFinish(response.status, body?.error);
  if (reason === 'rate_limited') {
    const retryAfterSeconds = parseRetryAfter(response.headers.get('Retry-After'));
    return retryAfterSeconds === undefined ? { ok: false, reason } : { ok: false, reason, retryAfterSeconds };
  }
  return { ok: false, reason };
}

function registerFailure(status: number, body: Record<string, unknown> | null): RegisterFailureReason {
  if (status === 403 && body?.error === 'registration_not_allowed') {
    return body.reason === 'reauth_required' ? 'reauth_required' : 'failed';
  }
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  // GoTrue の失敗に当たる 502・400（uv_required を含む）は、やり直せば通りうるので同じ扱いにする（判断10）。
  if (status === 502 || status === 400) return 'retry';
  if (status === 503) return 'unavailable';
  return 'failed';
}

/**
 * パスキーを登録する。始め → 鍵の作成 → 終わり → 端末の名前の変更（失敗は握る）。
 *
 * @impl IMPL-AUTH-307
 * @design DD-AUTH-060
 */
export async function registerPasskey(deps: {
  fetchApi: typeof clientFetch;
  create: typeof requestAttestation;
  deviceName: string;
}): Promise<RegisterResult> {
  let startResponse: Response;
  try {
    startResponse = await deps.fetchApi(`${BASE}/register/start`, { method: 'POST' });
  } catch {
    return { ok: false, reason: 'failed' };
  }
  const startBody = await readJson(startResponse);
  if (!startResponse.ok) return { ok: false, reason: registerFailure(startResponse.status, startBody) };
  if (!startBody || typeof startBody.challenge_id !== 'string' || !startBody.options) {
    return { ok: false, reason: 'failed' };
  }

  const created = await deps.create(startBody.options as Parameters<typeof requestAttestation>[0]);
  if (!created.ok) return { ok: false, reason: created.reason };

  let finishResponse: Response;
  try {
    finishResponse = await deps.fetchApi(`${BASE}/register/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge_id: startBody.challenge_id, credential: created.credential }),
    });
  } catch {
    return { ok: false, reason: 'failed' };
  }
  const finishBody = await readJson(finishResponse);
  if (!finishResponse.ok) return { ok: false, reason: registerFailure(finishResponse.status, finishBody) };
  const passkey = finishBody?.passkey as Record<string, unknown> | undefined;
  if (!passkey || typeof passkey.id !== 'string' || typeof passkey.created_at !== 'string') {
    return { ok: false, reason: 'failed' };
  }
  const summary: PasskeySummary = {
    id: passkey.id,
    friendly_name: typeof passkey.friendly_name === 'string' ? passkey.friendly_name : null,
    created_at: passkey.created_at,
  };

  const renamed = await renameWith(deps.fetchApi, summary.id, deps.deviceName);
  if (renamed.ok) {
    return { ok: true, passkey: { ...summary, friendly_name: renamed.passkey.friendly_name }, nameApplied: true };
  }
  return { ok: true, passkey: summary, nameApplied: false };
}

/**
 * 自分のパスキーの一覧。
 *
 * @impl IMPL-AUTH-308
 * @design DD-AUTH-060
 */
export function listPasskeys(): Promise<ListResult> {
  return listWith(clientFetch);
}

async function listWith(fetchApi: typeof clientFetch): Promise<ListResult> {
  let response: Response;
  try {
    response = await fetchApi(BASE, { method: 'GET' });
  } catch {
    return { ok: false, reason: 'failed' };
  }
  if (!response.ok) return manageFailure(response.status);
  const body = await readJson(response);
  if (!body || !Array.isArray(body.passkeys)) return { ok: false, reason: 'failed' };
  const passkeys: ListedPasskey[] = [];
  for (const entry of body.passkeys as unknown[]) {
    const item = entry as Record<string, unknown> | null;
    if (!item || typeof item.id !== 'string' || typeof item.created_at !== 'string') return { ok: false, reason: 'failed' };
    passkeys.push({
      id: item.id,
      friendly_name: typeof item.friendly_name === 'string' ? item.friendly_name : null,
      created_at: item.created_at,
      last_used_at: typeof item.last_used_at === 'string' ? item.last_used_at : null,
      ...(typeof item.approved === 'boolean' ? { approved: item.approved } : {}),
    });
  }
  return {
    ok: true,
    passkeys,
    isStaff: body.isStaff === true,
    ...(typeof body.approvedCount === 'number' ? { approvedCount: body.approvedCount } : {}),
  };
}

/**
 * パスキーの名前を変える。
 *
 * @impl IMPL-AUTH-309
 * @design DD-AUTH-060
 */
export function renamePasskey(id: string, name: string): Promise<RenameResult> {
  return renameWith(clientFetch, id, name);
}

async function renameWith(fetchApi: typeof clientFetch, id: string, name: string): Promise<RenameResult> {
  let response: Response;
  try {
    response = await fetchApi(`${BASE}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendly_name: name }),
    });
  } catch {
    return { ok: false, reason: 'failed' };
  }
  if (!response.ok) return manageFailure(response.status);
  const body = await readJson(response);
  const passkey = body?.passkey as Record<string, unknown> | undefined;
  if (!passkey || typeof passkey.id !== 'string' || typeof passkey.friendly_name !== 'string') {
    return { ok: false, reason: 'failed' };
  }
  return { ok: true, passkey: { id: passkey.id, friendly_name: passkey.friendly_name } };
}

/**
 * パスキーを消す。
 *
 * @impl IMPL-AUTH-310
 * @design DD-AUTH-060
 */
export async function deletePasskey(id: string): Promise<DeleteResult> {
  const fetchApi = clientFetch;
  let response: Response;
  try {
    response = await fetchApi(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch {
    return { ok: false, reason: 'failed' };
  }
  if (!response.ok) return manageFailure(response.status);
  return { ok: true };
}
