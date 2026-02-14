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
  });

  test('header matches stored -> allowed', async () => {
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue({ value: 'rtok' }) });
    headers.mockReturnValue({ get: jest.fn().mockReturnValue('header-token') });
    const storedHash = await tokenHashSha256('header-token');
    const maybeSingle = jest.fn().mockResolvedValue({ data: { csrf_token_hash: storedHash } });
    const eqSelect = jest.fn().mockReturnValue({ maybeSingle });
    const select = jest.fn().mockReturnValue({ eq: eqSelect });
    const eqUpdate = jest.fn().mockResolvedValue({});
    const update = jest.fn().mockReturnValue({ eq: eqUpdate });
    createServiceRoleClient.mockReturnValue({ from: jest.fn().mockReturnValue({ select, update }) });

    const res: any = await requireCsrfOrDeny();
    // When CSRF verification succeeds, the middleware rotates the token
    expect(res).toBeDefined();
    expect(res.rotatedCsrfToken).toBeDefined();
  });
});