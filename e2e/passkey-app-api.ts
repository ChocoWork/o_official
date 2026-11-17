/**
 * パスキーのログインの窓口（始め・終わり）をアプリの HTTP で直に呼ぶ、試験の道具（e2e/passkey-app-api.ts）。手元だけ。
 * Cookie は呼び手の `request` の文脈（APIRequestContext）に入る。窓口へは Origin と、試験ごとに別の `x-real-ip` を付ける
 * （proxy の Origin の確かめと、回数の枠を使い切らないため）。トークン・Cookie の値は失敗の文面に出さない。
 *
 * @packageDocumentation
 */
import type { APIRequestContext } from '@playwright/test';
import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON, SoftAuthenticator } from './passkey-soft-authenticator';

const ORIGIN = 'http://localhost:3000';
const START = '/api/auth/passkey/login/start';
const FINISH = '/api/auth/passkey/login/finish';

export type StartLoginResult = { challengeId: string; options: PublicKeyCredentialRequestOptionsJSON; status: number };
export type FinishLoginResult = { status: number; body: unknown; cookies: Array<{ name: string; value: string }> };

function headers(ip: string): Record<string, string> {
  return { origin: ORIGIN, 'x-real-ip': ip };
}

/**
 * 始め (a)。200 以外は、状態だけを文面に出して投げる。
 *
 * @impl IMPL-AUTH-282
 * @design DD-AUTH-055
 */
export async function startLoginViaApp(request: APIRequestContext, input: { ip: string }): Promise<StartLoginResult> {
  const res = await request.post(START, { headers: headers(input.ip), failOnStatusCode: false });
  if (res.status() !== 200) throw new Error(`ログインの始めが 200 でない（status: ${res.status()}）`);
  const body = (await res.json()) as { challenge_id?: string; options?: PublicKeyCredentialRequestOptionsJSON };
  if (!body.challenge_id || !body.options) throw new Error('ログインの始めの応答の形が違う');
  return { challengeId: body.challenge_id, options: body.options, status: res.status() };
}

/**
 * 終わり。呼び手が決めた応答（認証器の応答・改ざんした応答）をそのまま送る。
 *
 * @impl IMPL-AUTH-284
 * @design DD-AUTH-055
 */
export async function finishLoginViaApp(
  request: APIRequestContext,
  input: { ip: string; challengeId: string; credential: AuthenticationResponseJSON | Record<string, unknown>; next?: string },
): Promise<FinishLoginResult> {
  const res = await request.post(FINISH, {
    headers: headers(input.ip),
    data: { challenge_id: input.challengeId, credential: input.credential, ...(input.next ? { next: input.next } : {}) },
    failOnStatusCode: false,
    maxRedirects: 0,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const state = await request.storageState();
  return { status: res.status(), body, cookies: state.cookies.map(({ name, value }) => ({ name, value })) };
}

/**
 * 始め → 認証器の authenticate → 終わり。UV を落とす時は userVerified: false。
 *
 * @impl IMPL-AUTH-285
 * @design DD-AUTH-055
 */
export async function loginViaApp(
  request: APIRequestContext,
  input: { authenticator: SoftAuthenticator; ip: string; next?: string; userVerified?: boolean },
): Promise<FinishLoginResult> {
  const started = await startLoginViaApp(request, { ip: input.ip });
  const credential = input.authenticator.authenticate(
    started.options,
    input.userVerified === undefined ? undefined : { userVerified: input.userVerified },
  );
  return finishLoginViaApp(request, { ip: input.ip, challengeId: started.challengeId, credential, next: input.next });
}

const REGISTER_START = '/api/auth/passkey/register/start';
const REGISTER_FINISH = '/api/auth/passkey/register/finish';

export type RegisterViaAppHeaders = {
  /** `Bearer <access token>` など、要求ごとの見出し（Cookie は呼び手の `request` の文脈から付く） */
  authorization?: string;
  /** Cookie で呼ぶ時の `x-csrf-token`（`sb-csrf-token` の Cookie の値） */
  csrfToken?: string;
};
export type RegisterStartResult = { status: number; body: unknown };
export type RegisterFinishResult = { status: number; body: unknown };

function registerHeaders(ip: string, extra: RegisterViaAppHeaders): Record<string, string> {
  return {
    ...headers(ip),
    ...(extra.authorization ? { authorization: extra.authorization } : {}),
    ...(extra.csrfToken ? { 'x-csrf-token': extra.csrfToken } : {}),
  };
}

async function readJson(res: { json: () => Promise<unknown> }): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * 登録の始め。どの状態でも投げず、状態と本文を返す（断りを確かめる試験が使う）。
 *
 * @impl IMPL-AUTH-287
 * @design DD-AUTH-056
 */
export async function startRegisterViaApp(
  request: APIRequestContext,
  input: { ip: string } & RegisterViaAppHeaders,
): Promise<RegisterStartResult> {
  const res = await request.post(REGISTER_START, {
    headers: registerHeaders(input.ip, input),
    failOnStatusCode: false,
    maxRedirects: 0,
  });
  return { status: res.status(), body: await readJson(res) };
}

/**
 * 登録の終わり。呼び手が決めた応答（認証器の応答・改ざんした応答）をそのまま送る。
 *
 * @impl IMPL-AUTH-288
 * @design DD-AUTH-056
 */
export async function finishRegisterViaApp(
  request: APIRequestContext,
  input: { ip: string; challengeId: string; credential: Record<string, unknown> } & RegisterViaAppHeaders,
): Promise<RegisterFinishResult> {
  const res = await request.post(REGISTER_FINISH, {
    headers: registerHeaders(input.ip, input),
    data: { challenge_id: input.challengeId, credential: input.credential },
    failOnStatusCode: false,
    maxRedirects: 0,
  });
  return { status: res.status(), body: await readJson(res) };
}
