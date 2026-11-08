jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockLogAudit = jest.fn();
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));
const mockRecordHeartbeat = jest.fn();
jest.mock('@/lib/ops/ops-store', () => ({ recordHeartbeat: (...args: unknown[]) => mockRecordHeartbeat(...args) }));
const mockRunPosting = jest.fn();
jest.mock('@/lib/accounting/posting-runner', () => ({ runAccountingPosting: (...args: unknown[]) => mockRunPosting(...args) }));
const mockCountOpen = jest.fn();
jest.mock('@/lib/accounting/posting-store', () => ({ countOpenPendingEvents: (...args: unknown[]) => mockCountOpen(...args) }));

import * as cronRoute from '@/app/api/cron/accounting-post/route';
import { createServiceRoleClient } from '@/lib/supabase/server';

const { POST } = cronRoute;
const CRON_SECRET = 'cron-secret-for-unit-tests-0123456789';
const mockDatabase = { name: 'service-role-client' };
const RESULT = { payments: 2, shipments: 3, stripe: 4, disputes: 1, parked: 5, resolved: 6, hasMore: false };

function authorizedRequest(): Request {
  return new Request('http://localhost/api/cron/accounting-post', { method: 'POST', headers: { authorization: `Bearer ${CRON_SECRET}` } });
}

describe('POST /api/cron/accounting-post', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET;
    jest.resetAllMocks();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
    (createServiceRoleClient as jest.Mock).mockResolvedValue(mockDatabase);
    mockLogAudit.mockResolvedValue(undefined);
    mockRecordHeartbeat.mockResolvedValue(undefined);
    mockRunPosting.mockResolvedValue(RESULT);
    mockCountOpen.mockResolvedValue(9);
  });
  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
    delete process.env.CRON_SECRET;
  });

  it('FREQ-569-AC-01: cronは合言葉なし・違う合言葉・32文字未満を断り、係も心拍も監査も動かさない', async () => {
    expect((await POST(new Request('http://localhost/api/cron/accounting-post', { method: 'POST' }))).status).toBe(401);
    expect((await POST(new Request('http://localhost/api/cron/accounting-post', { method: 'POST', headers: { authorization: `Bearer ${CRON_SECRET.slice(0, -1)}X` } }))).status).toBe(401);
    process.env.CRON_SECRET = 'short-secret';
    expect((await POST(new Request('http://localhost/api/cron/accounting-post', { method: 'POST', headers: { authorization: 'Bearer short-secret' } }))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await POST(authorizedRequest())).status).toBe(401);
    expect(mockRunPosting).not.toHaveBeenCalled();
    expect(mockRecordHeartbeat).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it('FREQ-569-AC-01: POSTだけを受ける（pg_net は POST で呼ぶ）。実行は最大120秒', () => {
    expect('GET' in cronRoute).toBe(false);
    expect(cronRoute.maxDuration).toBe(120);
  });

  it('FREQ-569-AC-01: 係を流し、heartbeatと監査を残し、応答は件数だけ', async () => {
    const response = await POST(authorizedRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRunPosting).toHaveBeenCalledTimes(1);
    expect(mockRunPosting).toHaveBeenCalledWith(mockDatabase);
    expect(body).toEqual({ data: { ...RESULT, openPending: 9 } });
    expect(Object.values(body.data).every((value) => typeof value === 'number' || typeof value === 'boolean')).toBe(true);
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockDatabase, 'accounting_post', true, null);
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'accounting.post',
      resource: 'accounting',
      outcome: 'success',
      detail: 'Accounting posting',
      metadata: { ...RESULT, openPending: 9 },
    });
  });

  it('FREQ-569-AC-01: 係が失敗したら502にし、心拍に失敗と原因の記号だけを残す（例外の文・個人の情報は出さない）', async () => {
    mockRunPosting.mockRejectedValue(Object.assign(new Error('PRIVATE-MARKER 氏名 住所'), { code: 'db_unavailable' }));

    const response = await POST(authorizedRequest());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Posting failed' });
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockDatabase, 'accounting_post', false, 'db_unavailable');
    expect(error).toHaveBeenCalledWith('[accounting-post] Posting failed', 'db_unavailable');
    expect(JSON.stringify(error.mock.calls)).not.toContain('PRIVATE-MARKER');
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('FREQ-569-AC-01: 接続が作れない時も502にして、心拍は記録しようがなくても落ちない', async () => {
    (createServiceRoleClient as jest.Mock).mockRejectedValue(new Error('down'));
    const response = await POST(authorizedRequest());
    expect(response.status).toBe(502);
    expect(mockRunPosting).not.toHaveBeenCalled();
    expect(mockRecordHeartbeat).not.toHaveBeenCalled();
  });

  it('FREQ-569-AC-01: 心拍を記録できなくても、係が成功していれば200のまま（ログには例外の名前だけ）', async () => {
    mockRecordHeartbeat.mockRejectedValue(new Error('PRIVATE-MARKER db down'));
    const response = await POST(authorizedRequest());
    expect(response.status).toBe(200);
    expect(mockRunPosting).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('[accounting-post] Failed to record heartbeat', 'Error');
    expect(JSON.stringify(error.mock.calls)).not.toContain('PRIVATE-MARKER');
  });
});
