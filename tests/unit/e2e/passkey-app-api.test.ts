/** @jest-environment node */
/**
 * DD-AUTH-055 試験の道具 e2e/passkey-app-api.ts（窓口を HTTP で直に呼ぶ関数）の単体テスト。APIRequestContext は偽物で、送った要求と戻りの形だけを確かめる。
 */
import type { APIRequestContext } from '@playwright/test';
import { finishLoginViaApp, loginViaApp, startLoginViaApp } from '../../../e2e/passkey-app-api';
import type { SoftAuthenticator } from '../../../e2e/passkey-soft-authenticator';

type Sent = { path: string; options: { headers: Record<string, string>; data?: Record<string, unknown> } };

function fakeRequest(responses: Array<{ status: number; json: () => Promise<unknown> }>) {
  const sent: Sent[] = [];
  const request = {
    post: jest.fn(async (path: string, options: Sent['options']) => {
      sent.push({ path, options });
      return { status: () => responses[sent.length - 1].status, json: responses[sent.length - 1].json };
    }),
    storageState: jest.fn(async () => ({ cookies: [{ name: 'sb-access-token', value: 'v', extra: 1 }] })),
  } as unknown as APIRequestContext;
  return { request, sent };
}

const startOk = { status: 200, json: async () => ({ challenge_id: 'c1', options: { challenge: 'x' } }) };

describe('DD-AUTH-055 startLoginViaApp', () => {
  test('DD-AUTH-055 origin と x-real-ip を付けて始めを呼び、challengeId と options を返す', async () => {
    const { request, sent } = fakeRequest([startOk]);
    const result = await startLoginViaApp(request, { ip: '10.0.0.1' });
    expect(result).toEqual({ challengeId: 'c1', options: { challenge: 'x' }, status: 200 });
    expect(sent[0].path).toBe('/api/auth/passkey/login/start');
    expect(sent[0].options.headers).toEqual({ origin: 'http://localhost:3000', 'x-real-ip': '10.0.0.1' });
  });

  test('DD-AUTH-055 200 でなければ状態だけを文面に出して投げる', async () => {
    const { request } = fakeRequest([{ status: 503, json: async () => ({}) }]);
    await expect(startLoginViaApp(request, { ip: '10.0.0.1' })).rejects.toThrow('status: 503');
  });

  test('DD-AUTH-055 応答の形が違えば投げる', async () => {
    const { request } = fakeRequest([{ status: 200, json: async () => ({}) }]);
    await expect(startLoginViaApp(request, { ip: '10.0.0.1' })).rejects.toThrow('形が違う');
  });
});

describe('DD-AUTH-055 finishLoginViaApp と loginViaApp', () => {
  test('DD-AUTH-055 終わりに challenge_id・credential・next を送り、状態・本文・Cookie（名前と値だけ）を返す', async () => {
    const { request, sent } = fakeRequest([{ status: 200, json: async () => ({ ok: 1 }) }]);
    const result = await finishLoginViaApp(request, { ip: '10.0.0.2', challengeId: 'c1', credential: { id: 'a' }, next: '/admin' });
    expect(result).toEqual({ status: 200, body: { ok: 1 }, cookies: [{ name: 'sb-access-token', value: 'v' }] });
    expect(sent[0].path).toBe('/api/auth/passkey/login/finish');
    expect(sent[0].options.data).toEqual({ challenge_id: 'c1', credential: { id: 'a' }, next: '/admin' });
  });

  test('DD-AUTH-055 next が無ければ本文に next を入れず、JSON でない応答の本文は null', async () => {
    const { request, sent } = fakeRequest([
      {
        status: 502,
        json: async () => {
          throw new Error('not json');
        },
      },
    ]);
    const result = await finishLoginViaApp(request, { ip: '10.0.0.2', challengeId: 'c1', credential: {} });
    expect(result.body).toBeNull();
    expect(sent[0].options.data).toEqual({ challenge_id: 'c1', credential: {} });
  });

  test('DD-AUTH-055 loginViaApp は始め → authenticate → 終わりの順で、userVerified を認証器に渡す', async () => {
    const { request, sent } = fakeRequest([startOk, { status: 400, json: async () => ({ error: 'uv_required' }) }]);
    const authenticate = jest.fn(() => ({ id: 'a' }));
    const authenticator = { authenticate } as unknown as SoftAuthenticator;
    const result = await loginViaApp(request, { authenticator, ip: '10.0.0.3', userVerified: false });
    expect(authenticate).toHaveBeenCalledWith({ challenge: 'x' }, { userVerified: false });
    expect(sent.map((entry) => entry.path)).toEqual(['/api/auth/passkey/login/start', '/api/auth/passkey/login/finish']);
    expect(result.status).toBe(400);
  });

  test('DD-AUTH-055 userVerified を渡さなければ authenticate の第2引数は無い', async () => {
    const { request } = fakeRequest([startOk, { status: 200, json: async () => ({}) }]);
    const authenticate = jest.fn(() => ({ id: 'a' }));
    await loginViaApp(request, { authenticator: { authenticate } as unknown as SoftAuthenticator, ip: '10.0.0.3' });
    expect(authenticate).toHaveBeenCalledWith({ challenge: 'x' }, undefined);
  });
});
