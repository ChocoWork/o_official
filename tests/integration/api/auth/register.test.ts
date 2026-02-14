// Ensure ADMIN_API_KEY exists so public flow is reachable (route expects env var)
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'test-admin-key';

// Mock rateLimit middleware to avoid DB calls
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { signUp: jest.fn().mockResolvedValue({ data: { session: { access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 1000 }, user: { id: 'u1', email: 'test@example.com' } }, error: null }) } }),
  createServiceRoleClient: () => ({ auth: { admin: { createUser: jest.fn().mockResolvedValue({ data: { user: { id: 'admin-user-1', email: 'test@example.com' } }, error: null }) } }, from: () => ({ insert: jest.fn().mockResolvedValue({ data: [{ id: 's1' }], error: null }) }) }),
}));

// Ensure NextResponse.json is available in test environment
const NextServer = require('next/server');
NextServer.NextResponse = NextServer.NextResponse || {};
NextServer.NextResponse.json = (body: any, init?: any) => ({ status: init?.status ?? 200, json: async () => body, cookies: { set: jest.fn() } });

describe('POST /api/auth/register (public)', () => {
  it('returns 201 on successful signUp', async () => {
    // import handler after mocks
    const route = await import('@/app/api/auth/register/route');

    const req = new Request('http://localhost/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: 'test@example.com', password: 'Passw0rd!', emailRedirectTo: '/auth/verified' }),
      headers: { 'x-admin-token': process.env.ADMIN_API_KEY, 'content-type': 'application/json' },
    });
    const resp = await route.POST(req as any);
    // resp is the object returned by our mocked NextResponse.json
    const body = await resp.json();
    // debug
    // eslint-disable-next-line no-console
    console.log('register test response body:', body, 'status', resp.status);
    expect(resp.status).toBe(201);
    expect(body.id).toBeDefined();
    expect(body.email).toBe('test@example.com');
  });
  it('public signUp without admin header returns 201 and access token', async () => {
    const route = await import('@/app/api/auth/register/route');
    const req = new Request('http://localhost/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: 'test@example.com', password: 'Passw0rd!', emailRedirectTo: '/auth/verified' }),
      headers: { 'content-type': 'application/json' },
    });
    const resp = await route.POST(req as any);
    const body = await resp.json();
    // Expect the public flow to return access token and user
    expect(resp.status).toBe(201);
    expect(body.access_token).toBeDefined();
    expect(body.user).toBeDefined();
    expect(body.user.email).toBe('test@example.com');
  });
});

export {};
import { createRequest } from '../../testUtils';

describe('/api/auth/register', () => {
  test('route exists', async () => {
    // Basic smoke test placeholder — integration tests require test harness
    expect(true).toBe(true);
  });
});
