jest.mock('@/features/auth/ratelimit', () => ({
  incrementCounter: jest.fn(),
}));

import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
const { incrementCounter } = require('@/features/auth/ratelimit');

describe('rateLimit middleware', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('allows request when under limit', async () => {
    (incrementCounter as jest.Mock).mockResolvedValue(1);
    const req = new Request('http://localhost', { headers: { 'x-forwarded-for': '1.2.3.4' } });
    const res = await enforceRateLimit({ request: req as any, endpoint: 'auth:login', limit: 5, windowSeconds: 600 });
    expect(res).toBeUndefined();
    expect(incrementCounter).toHaveBeenCalled();
  });

  test('blocks when over limit', async () => {
    (incrementCounter as jest.Mock).mockResolvedValue(10);
    const req = new Request('http://localhost', { headers: { 'x-forwarded-for': '1.2.3.4' } });
    const res: any = await enforceRateLimit({ request: req as any, endpoint: 'auth:login', limit: 5, windowSeconds: 600 });
    expect(res).toBeDefined();
    expect(res.status).toBe(429);
    expect(res._body).toMatchObject({ error: 'Too many requests' });
  });
});
