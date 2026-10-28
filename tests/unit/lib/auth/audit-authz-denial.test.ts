jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn(),
}));

jest.mock('@/features/auth/ratelimit', () => ({
  incrementCounter: jest.fn(),
}));

import { AUTHZ_DENIAL_AUDIT_LIMIT, auditAuthzDenial } from '@/lib/auth/audit-authz-denial';
import type { AuthzDenial, AuthzFailure } from '@/lib/auth/admin-rbac';

const { logAudit } = require('@/lib/audit');
const { incrementCounter } = require('@/features/auth/ratelimit');

const DENIAL: AuthzDenial = {
  userId: 'user-1',
  email: 'support@example.com',
  role: 'supporter',
  permission: 'admin.stockists.manage',
  reason: 'permission',
};

const failure = (denial?: AuthzDenial): AuthzFailure =>
  ({ ok: false, response: { status: 403 } as never, ...(denial ? { denial } : {}) }) as AuthzFailure;

const requestWith = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/admin/stockists/1', { method: 'PATCH', headers });

const INPUT = { action: 'admin_stockists_update', resource: 'stockists' };

describe('DD-STOCKIST-039: auditAuthzDenial', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    incrementCounter.mockResolvedValue(1);
    logAudit.mockResolvedValue(undefined);
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('DD-STOCKIST-039: 上限は操作者ごとに 20 行', () => {
    expect(AUTHZ_DENIAL_AUDIT_LIMIT).toBe(20);
  });

  it('DD-STOCKIST-039: actor が分かる拒否は、失敗の 1 行を残す（権限・理由・役割・操作者・送り元の文脈）', async () => {
    await auditAuthzDenial(failure(DENIAL), {
      request: requestWith({ 'x-real-ip': '203.0.113.7', 'user-agent': 'jest-agent' }),
      ...INPUT,
    });

    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'admin_stockists_update',
      outcome: 'failure',
      detail: 'Forbidden: admin.stockists.manage (permission)',
      metadata: { permission: 'admin.stockists.manage', reason: 'permission', role: 'supporter' },
      resource: 'stockists',
      actor_id: 'user-1',
      actor_email: 'support@example.com',
      ip: '203.0.113.7',
      user_agent: 'jest-agent',
    });
  });

  it('DD-STOCKIST-039: 数えは操作者ごと（subject=userId）で、600 秒の区切りの物を使う', async () => {
    await auditAuthzDenial(failure(DENIAL), { request: requestWith(), ...INPUT });

    expect(incrementCounter).toHaveBeenCalledTimes(1);
    const arg = incrementCounter.mock.calls[0][0];
    expect(arg.endpoint).toBe('admin_authz_denial_audit');
    expect(arg.subject).toBe('user-1');
    expect(Date.parse(arg.bucket) % 600_000).toBe(0);
  });

  it('DD-STOCKIST-039: 偽の x-forwarded-for は IP に入れない（見出しが無ければ ip は null）', async () => {
    await auditAuthzDenial(failure(DENIAL), {
      request: requestWith({ 'x-forwarded-for': '198.51.100.9' }),
      ...INPUT,
    });

    expect(logAudit.mock.calls[0][0].ip).toBeNull();
    expect(JSON.stringify(logAudit.mock.calls[0][0])).not.toContain('198.51.100.9');
  });

  it.each([
    ['session', 'Forbidden: admin.stockists.manage (session)'],
    ['mfa', 'Forbidden: admin.stockists.manage (mfa)'],
  ] as const)('DD-STOCKIST-039: 理由 %s も同じ形で残す', async (reason, detail) => {
    await auditAuthzDenial(failure({ ...DENIAL, reason }), { request: requestWith(), ...INPUT });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', detail, metadata: expect.objectContaining({ reason }) }),
    );
  });

  it('DD-STOCKIST-039: メールの無い操作者は actor_email=null', async () => {
    await auditAuthzDenial(failure({ ...DENIAL, email: null }), { request: requestWith(), ...INPUT });

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ actor_id: 'user-1', actor_email: null }));
  });

  it('DD-STOCKIST-039: denial が無い拒否（token 無しの 401・503・500）は、数えも書きもしない', async () => {
    await auditAuthzDenial(failure(), { request: requestWith(), ...INPUT });

    expect(incrementCounter).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('DD-STOCKIST-039: 成功の結果が渡されても何もしない', async () => {
    await auditAuthzDenial({ ok: true } as never, { request: requestWith(), ...INPUT });

    expect(incrementCounter).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it.each([1, 19, 20])('DD-STOCKIST-039: 数えが %i の時は失敗の 1 行を残す', async (count) => {
    incrementCounter.mockResolvedValue(count);

    await auditAuthzDenial(failure(DENIAL), { request: requestWith(), ...INPUT });

    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][0].outcome).toBe('failure');
  });

  it('DD-STOCKIST-039: 21 回目は denied_burst のまとめの 1 行だけ（操作者の情報は残す）', async () => {
    incrementCounter.mockResolvedValue(21);

    await auditAuthzDenial(failure(DENIAL), { request: requestWith(), ...INPUT });

    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin_stockists_update',
        outcome: 'denied_burst',
        resource: 'stockists',
        actor_id: 'user-1',
        actor_email: 'support@example.com',
      }),
    );
  });

  it.each([22, 25, 1000])('DD-STOCKIST-039: 数えが %i の時は何も書かない', async (count) => {
    incrementCounter.mockResolvedValue(count);

    await auditAuthzDenial(failure(DENIAL), { request: requestWith(), ...INPUT });

    expect(logAudit).not.toHaveBeenCalled();
  });

  it('DD-STOCKIST-039: 25 回断られると、20 行＋まとめの 1 行で止まる', async () => {
    let n = 0;
    incrementCounter.mockImplementation(async () => ++n);

    for (let i = 0; i < 25; i += 1) {
      await auditAuthzDenial(failure(DENIAL), { request: requestWith(), ...INPUT });
    }

    const outcomes = logAudit.mock.calls.map((c: unknown[]) => (c[0] as { outcome: string }).outcome);
    expect(outcomes.filter((o: string) => o === 'failure')).toHaveLength(20);
    expect(outcomes.filter((o: string) => o === 'denied_burst')).toHaveLength(1);
    expect(outcomes).toHaveLength(21);
  });

  it('DD-STOCKIST-039: 数えに失敗したら何も書かず、投げない（応答を変えない）', async () => {
    incrementCounter.mockRejectedValue(new Error('rpc down'));

    await expect(auditAuthzDenial(failure(DENIAL), { request: requestWith(), ...INPUT })).resolves.toBeUndefined();

    expect(logAudit).not.toHaveBeenCalled();
  });

  it('DD-STOCKIST-039: logAudit が投げても、投げない', async () => {
    logAudit.mockRejectedValue(new Error('db down'));

    await expect(auditAuthzDenial(failure(DENIAL), { request: requestWith(), ...INPUT })).resolves.toBeUndefined();
  });
});
