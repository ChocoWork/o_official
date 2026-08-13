export {};

jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn(), }));
jest.mock('next/headers', () => ({ headers: jest.fn(), cookies: jest.fn() }));
jest.mock('next/server', () => ({ NextResponse: { json: (body: any, init?: any) => ({ status: init?.status ?? 200, _body: body }) } }));

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
    expect(res.status).toBe(403);
    expect(res._body).toEqual({ error: 'Forbidden', reason: 'CSRF validation failed' });
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
    expect(res.status).toBe(403);
    expect(res._body).toEqual({ error: 'Forbidden', reason: 'CSRF validation failed' });
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
