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
    const req = new Request('http://localhost', { headers: { 'x-real-ip': '1.2.3.4' } });
    const res = await enforceRateLimit({ request: req as any, endpoint: 'auth:login', limit: 5, windowSeconds: 600 });
    expect(res).toBeUndefined();
    expect(incrementCounter).toHaveBeenCalled();
  });

  test('blocks when over limit', async () => {
    (incrementCounter as jest.Mock).mockResolvedValue(10);
    const req = new Request('http://localhost', { headers: { 'x-real-ip': '1.2.3.4' } });
    const res: any = await enforceRateLimit({ request: req as any, endpoint: 'auth:login', limit: 5, windowSeconds: 600 });
    expect(res).toBeDefined();
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toEqual({ error: 'Too many requests' });
  });

  test('fails closed when rate limiter DB errors occur', async () => {
    (incrementCounter as jest.Mock).mockRejectedValue(new Error('DB unavailable'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const req = new Request('http://localhost', { headers: { 'x-real-ip': '1.2.3.4' } });
    const res: any = await enforceRateLimit({ request: req as any, endpoint: 'auth:login', limit: 5, windowSeconds: 600 });
    expect(res).toBeDefined();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: 'Rate limiter unavailable' });
    expect(res.headers.get('Retry-After')).toBe('600');
  });
});

describe('DD-AUTH-038 回数の制限の鍵（送り元は getClientIp から取る）', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (incrementCounter as jest.Mock).mockResolvedValue(1);
  });

  function firstCall(): { ip: string | null; endpoint: string; subject: string | null } {
    return (incrementCounter as jest.Mock).mock.calls[0][0];
  }

  test('x-real-ip を鍵にする（CLIENT_IP_HEADER は jest の準備 tests/setupClientIp.js で立てる）', async () => {
    const req = new Request('http://localhost', { headers: { 'x-real-ip': '1.2.3.4' } });
    await enforceRateLimit({ request: req as any, endpoint: 'auth:login' });
    expect(firstCall().ip).toBe('1.2.3.4');
  });

  test('x-forwarded-for だけの要求は鍵が null（偽れる見出しは読まない）', async () => {
    const req = new Request('http://localhost', { headers: { 'x-forwarded-for': '1.2.3.4' } });
    await enforceRateLimit({ request: req as any, endpoint: 'auth:login' });
    expect(firstCall().ip).toBeNull();
  });

  test('x-forwarded-for と x-real-ip が両方在れば x-real-ip を使う', async () => {
    const req = new Request('http://localhost', { headers: { 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '1.2.3.4' } });
    await enforceRateLimit({ request: req as any, endpoint: 'auth:login' });
    expect(firstCall().ip).toBe('1.2.3.4');
  });

  test('request が無い時は鍵が null（inet に入らない unknown や固定の 127.0.0.1 は使わない）', async () => {
    await enforceRateLimit({ endpoint: 'auth:login' });
    expect(firstCall().ip).toBeNull();
  });

  test('IP の形でない x-real-ip は鍵が null', async () => {
    const req = new Request('http://localhost', { headers: { 'x-real-ip': 'foo' } });
    await enforceRateLimit({ request: req as any, endpoint: 'auth:login' });
    expect(firstCall().ip).toBeNull();
  });

  test('subject を渡した時は従来どおり subject も incrementCounter へ渡す', async () => {
    const req = new Request('http://localhost', { headers: { 'x-real-ip': '1.2.3.4' } });
    await enforceRateLimit({ request: req as any, endpoint: 'auth:login', subject: 'user-1' });
    expect(firstCall().subject).toBe('user-1');
  });
});

describe('DD-AUTH-038 回数の制限の 429・503 に no-store と Retry-After が付く', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  test('429 は Cache-Control: private, no-store と Retry-After を持つ', async () => {
    (incrementCounter as jest.Mock).mockResolvedValue(10);
    const req = new Request('http://localhost', { headers: { 'x-real-ip': '1.2.3.4' } });
    const res: any = await enforceRateLimit({ request: req as any, endpoint: 'auth:login', limit: 5, windowSeconds: 600 });
    expect(res.status).toBe(429);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Retry-After')).toBe('600');
  });

  test('503 も Cache-Control: private, no-store と Retry-After を持つ', async () => {
    (incrementCounter as jest.Mock).mockRejectedValue(new Error('DB unavailable'));
    const req = new Request('http://localhost', { headers: { 'x-real-ip': '1.2.3.4' } });
    const res: any = await enforceRateLimit({ request: req as any, endpoint: 'auth:login', windowSeconds: 300 });
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Retry-After')).toBe('300');
  });

  describe('NextResponse が使えない環境の Response の枝', () => {
    let isolated: typeof import('@/features/auth/middleware/rateLimit');
    let counter: jest.Mock;

    beforeEach(() => {
      jest.isolateModules(() => {
        jest.doMock('next/server', () => ({
          NextResponse: {
            json: () => {
              throw new Error('NextResponse unavailable');
            },
          },
        }));
        jest.doMock('@/features/auth/ratelimit', () => ({ incrementCounter: jest.fn() }));
        isolated = require('@/features/auth/middleware/rateLimit');
        counter = require('@/features/auth/ratelimit').incrementCounter;
      });
    });

    afterEach(() => {
      jest.dontMock('next/server');
    });

    test('429 も no-store を付ける', async () => {
      counter.mockResolvedValue(10);
      const req = new Request('http://localhost', { headers: { 'x-real-ip': '1.2.3.4' } });
      const res: any = await isolated.enforceRateLimit({ request: req as any, endpoint: 'auth:login', limit: 5 });
      expect(res.status).toBe(429);
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    });

    test('503 も no-store を付ける', async () => {
      counter.mockRejectedValue(new Error('DB unavailable'));
      const req = new Request('http://localhost', { headers: { 'x-real-ip': '1.2.3.4' } });
      const res: any = await isolated.enforceRateLimit({ request: req as any, endpoint: 'auth:login' });
      expect(res.status).toBe(503);
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    });
  });
});
