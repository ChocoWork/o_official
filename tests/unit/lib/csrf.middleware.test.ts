export {};

jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn(), }));
jest.mock('next/headers', () => ({ headers: jest.fn(), cookies: jest.fn() }));
// 呼び元は拒否を `instanceof Response` で見分ける（R-22）ので、作り物の object ではなく本物の NextResponse を返す。
// 試験の環境の Response（node-fetch）には静的な json が無いため、NextResponse.json だけを本物の NextResponse の生成に置き換える。
jest.mock('next/server', () => {
  const { NextResponse } = jest.requireActual('next/server');
  return {
    NextResponse: {
      json: (body: unknown, init?: { status?: number }) =>
        new NextResponse(JSON.stringify(body), { status: init?.status ?? 200, headers: { 'content-type': 'application/json' } }),
    },
  };
});

const { headers, cookies } = require('next/headers');
const { createServiceRoleClient } = require('@/lib/supabase/server');
const { requireCsrfOrDeny } = require('../../../src/lib/csrfMiddleware');
const { tokenHashSha256 } = require('../../../src/lib/hash');

describe('CSRF middleware', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('no refresh cookie -> allowed', async () => {
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue(undefined) });
    const res = await requireCsrfOrDeny();
    expect(res).toBeUndefined();
  });

  test('missing header with refresh cookie -> 403', async () => {
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue({ value: 'rtok' }) });
    headers.mockReturnValue({ get: jest.fn().mockReturnValue(undefined) });
    const res = await requireCsrfOrDeny();
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden', reason: 'CSRF validation failed' });
  });

  test('header mismatched vs stored -> 403', async () => {
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue({ value: 'rtok' }) });
    headers.mockReturnValue({ get: jest.fn().mockReturnValue('header-token') });
    const storedHash = await tokenHashSha256('other-token');
    const maybeSingle = jest.fn().mockResolvedValue({ data: { csrf_token_hash: storedHash } });
    const eq = jest.fn().mockReturnValue({ maybeSingle });
    const select = jest.fn().mockReturnValue({ eq });
    createServiceRoleClient.mockReturnValue({ from: jest.fn().mockReturnValue({ select }) });

    const res = await requireCsrfOrDeny();
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden', reason: 'CSRF validation failed' });
  });

  test('照合の DB が落ちたら -> 500 の本物の Response', async () => {
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue({ value: 'rtok' }) });
    headers.mockReturnValue({ get: jest.fn().mockReturnValue('header-token') });
    createServiceRoleClient.mockImplementation(() => {
      throw new Error('db down');
    });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await requireCsrfOrDeny();
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  test('header matches stored -> allowed without rotating the stored hash', async () => {
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue({ value: 'rtok' }) });
    headers.mockReturnValue({ get: jest.fn().mockReturnValue('header-token') });
    const storedHash = await tokenHashSha256('header-token');
    const maybeSingle = jest.fn().mockResolvedValue({ data: { csrf_token_hash: storedHash } });
    const eqSelect = jest.fn().mockReturnValue({ maybeSingle });
    const select = jest.fn().mockReturnValue({ eq: eqSelect });
    const update = jest.fn();
    createServiceRoleClient.mockReturnValue({ from: jest.fn().mockReturnValue({ select, update }) });

    const res = await requireCsrfOrDeny();
    expect(res).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });
});
