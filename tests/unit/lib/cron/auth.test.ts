/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { authorizeCronBearer, authorizeCronRequest, MIN_CRON_SECRET_LENGTH } from '@/lib/cron/auth';

const SECRET = 'cron-secret-for-unit-tests-0123456789';

function request(authorization?: string): Request {
  return new Request('http://localhost/api/cron/x', {
    method: 'POST',
    headers: authorization ? { authorization } : {},
  });
}

describe('authorizeCronBearer（合言葉の比べ方）', () => {
  it('同じ合言葉だけを通す', () => {
    expect(authorizeCronBearer(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it.each([null, '', 'Bearer wrong', `Basic ${SECRET}`, `Bearer ${SECRET} `])('違うヘッダー %p は通さない', (value) => {
    expect(authorizeCronBearer(value, SECRET)).toBe(false);
  });

  it('合言葉が空なら通さない', () => {
    expect(authorizeCronBearer('Bearer ', '')).toBe(false);
    expect(authorizeCronBearer('Bearer ', undefined)).toBe(false);
  });
});

describe('authorizeCronRequest（CRON_SECRET で守る入口）', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('32文字以上で一致すれば通し、ログを出さない', () => {
    expect(MIN_CRON_SECRET_LENGTH).toBe(32);
    expect(authorizeCronRequest(request(`Bearer ${SECRET}`), 'worker', SECRET)).toEqual({ ok: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it('ちょうど32文字は通す', () => {
    const secret = 'a'.repeat(32);
    expect(authorizeCronRequest(request(`Bearer ${secret}`), 'worker', secret)).toEqual({ ok: true });
  });

  it('未設定は設定の誤りとして断り、ログに1行出す', () => {
    expect(authorizeCronRequest(request(`Bearer ${SECRET}`), 'worker', undefined)).toEqual({
      ok: false, reason: 'CRON_SECRET is not configured', misconfigured: true,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[cron] worker unauthorized', 'CRON_SECRET is not configured');
  });

  it('32文字未満は、ヘッダーが一致していても設定の誤りとして断る', () => {
    const secret = 'a'.repeat(31);
    expect(authorizeCronRequest(request(`Bearer ${secret}`), 'worker', secret)).toEqual({
      ok: false, reason: 'CRON_SECRET is shorter than 32 characters', misconfigured: true,
    });
  });

  it('ヘッダーが無い・一致しないときは断り、ヘッダーの値をログに出さない', () => {
    expect(authorizeCronRequest(request(), 'worker', SECRET)).toEqual({
      ok: false, reason: 'Missing Authorization header', misconfigured: false,
    });
    expect(authorizeCronRequest(request('Bearer attacker-supplied-value'), 'worker', SECRET)).toEqual({
      ok: false, reason: 'Authorization header does not match CRON_SECRET', misconfigured: false,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('attacker-supplied-value');
  });

  it('合言葉を渡さなければ process.env.CRON_SECRET を読む', () => {
    process.env.CRON_SECRET = SECRET;
    try {
      expect(authorizeCronRequest(request(`Bearer ${SECRET}`), 'worker')).toEqual({ ok: true });
    } finally {
      delete process.env.CRON_SECRET;
    }
  });
});

describe('CRON_SECRET で守る入口は、同じ確かめ方だけを使う', () => {
  it.each([
    'src/app/api/cron/process-stripe-webhooks/route.ts',
    'src/app/api/cron/expire-pending-orders/route.ts',
    'src/app/api/cron/stripe-reconcile/route.ts',
    'src/app/api/cron/meta-kpi-sync/route.ts',
  ])('%s', (file) => {
    const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
    expect(source).toContain("from '@/lib/cron/auth'");
    expect(source).toMatch(/authorizeCronRequest\(request, '[a-z-]+'\)/);
    expect(source).not.toMatch(/timingSafeEqual|process\.env\.CRON_SECRET|!==\s*`Bearer/);
  });
});
