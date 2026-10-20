jest.mock('next/server', () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));
const mockRecordHeartbeat = jest.fn();
jest.mock('@/lib/ops/ops-store', () => ({
  recordHeartbeat: (...args: unknown[]) => mockRecordHeartbeat(...args),
}));
const mockPurgeReturnPhotos = jest.fn();
jest.mock('@/lib/orders/returns/return-photo-storage', () => ({
  purgeReturnPhotos: (...args: unknown[]) => mockPurgeReturnPhotos(...args),
}));

import * as purgeRoute from '@/app/api/cron/purge-return-photos/route';
import { createServiceRoleClient } from '@/lib/supabase/server';

const mockDatabase = { name: 'service-role-client' };
const { POST } = purgeRoute;
// 定期処理の合言葉は32文字以上（設計書 2026-10-05 グループ B の 4-3）
const CRON_SECRET = 'cron-secret-for-unit-tests-0123456789';

function authorizedRequest(): Request {
  return new Request('http://localhost/api/cron/purge-return-photos', {
    method: 'POST',
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
}

describe('POST /api/cron/purge-return-photos', () => {
  let warn: jest.SpyInstance;
  let logged: jest.SpyInstance;

  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET;
    jest.clearAllMocks();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logged = jest.spyOn(console, 'error').mockImplementation(() => {});
    (createServiceRoleClient as jest.Mock).mockResolvedValue(mockDatabase);
    mockRecordHeartbeat.mockResolvedValue(undefined);
    mockPurgeReturnPhotos.mockResolvedValue({ uploads: 3, photos: 2 });
  });
  afterEach(() => {
    warn.mockRestore();
    logged.mockRestore();
    delete process.env.CRON_SECRET;
  });

  it('合言葉（Authorization の Bearer）が無い要求は 401 で、何も消さず、見回りの印も書かない', async () => {
    const response = await POST(new Request('http://localhost/api/cron/purge-return-photos', { method: 'POST' }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(mockPurgeReturnPhotos).not.toHaveBeenCalled();
    expect(mockRecordHeartbeat).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('合言葉が違う要求は 401', async () => {
    const response = await POST(new Request('http://localhost/api/cron/purge-return-photos', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-secret-wrong-secret-wrong-secret' },
    }));

    expect(response.status).toBe(401);
    expect(mockPurgeReturnPhotos).not.toHaveBeenCalled();
  });

  it('CRON_SECRET が32文字に満たなければ、ヘッダーが合っていても 401', async () => {
    process.env.CRON_SECRET = 'short-secret';

    const response = await POST(new Request('http://localhost/api/cron/purge-return-photos', {
      method: 'POST',
      headers: { authorization: 'Bearer short-secret' },
    }));

    expect(response.status).toBe(401);
    expect(mockPurgeReturnPhotos).not.toHaveBeenCalled();
  });

  it('POST だけ受ける（pg_net は POST しか送れない）', () => {
    expect('GET' in purgeRoute).toBe(false);
  });

  it('実行の上限は60秒', () => {
    expect(purgeRoute.maxDuration).toBe(60);
  });

  it('消した数を data に入れて 200 で返し、見回りの印に成功を書く', async () => {
    const response = await POST(authorizedRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { uploads: 3, photos: 2 } });
    expect(mockPurgeReturnPhotos).toHaveBeenCalledTimes(1);
    expect(mockPurgeReturnPhotos).toHaveBeenCalledWith(mockDatabase);
    expect(mockRecordHeartbeat).toHaveBeenCalledTimes(1);
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockDatabase, 'return_photo_purge', true, null);
  });

  it('対象が無い日（0件と0件）も成功として見回りの印を書く（動いたことが残る）', async () => {
    mockPurgeReturnPhotos.mockResolvedValue({ uploads: 0, photos: 0 });

    const response = await POST(authorizedRequest());

    expect(response.status).toBe(200);
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockDatabase, 'return_photo_purge', true, null);
  });

  it('監査には数だけを残し、置き場の場所や写真の番号は残さない。見回りの印は監査の後', async () => {
    await POST(authorizedRequest());

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'orders.return_photos.purge',
      resource: 'order_return_photos',
      outcome: 'success',
      detail: 'Return photo purge',
      metadata: { uploads: 3, photos: 2 },
    });
    expect(mockLogAudit.mock.invocationCallOrder[0]).toBeLessThan(mockRecordHeartbeat.mock.invocationCallOrder[0]);
  });

  it.each([
    ['storage_unavailable'],
    ['db_unavailable'],
  ])('消す処理が %s で止まったら 502 にし、その記号を見回りの印に残す', async (code) => {
    mockPurgeReturnPhotos.mockRejectedValue(Object.assign(new Error('failed: requests/order/upload'), { code }));

    const response = await POST(authorizedRequest());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Purge failed' });
    expect(mockRecordHeartbeat).toHaveBeenCalledTimes(1);
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockDatabase, 'return_photo_purge', false, code);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'orders.return_photos.purge',
      resource: 'order_return_photos',
      outcome: 'error',
      detail: code,
    });
  });

  it('想定外の失敗は unexpected_error の記号だけを残し、例外の文（置き場の場所が混ざりうる）はログにも答えにも出さない', async () => {
    mockPurgeReturnPhotos.mockRejectedValue(new Error('boom requests/11111111/22222222'));

    const response = await POST(authorizedRequest());

    expect(response.status).toBe(502);
    expect(mockRecordHeartbeat).toHaveBeenCalledWith(mockDatabase, 'return_photo_purge', false, 'unexpected_error');
    expect(logged).toHaveBeenCalledWith('[purge-return-photos] Purge failed', 'unexpected_error');
    expect(JSON.stringify([logged.mock.calls, mockLogAudit.mock.calls, await response.json()])).not.toContain('requests/');
  });

  it('service_role のクライアントを作れなくても 502 にする（見回りの印は書けないので書こうとしない）', async () => {
    (createServiceRoleClient as jest.Mock).mockRejectedValue(new Error('SUPABASE_SERVICE_ROLE_KEY must be set'));

    const response = await POST(authorizedRequest());

    expect(response.status).toBe(502);
    expect(mockPurgeReturnPhotos).not.toHaveBeenCalled();
    expect(mockRecordHeartbeat).not.toHaveBeenCalled();
  });

  it('見回りの印を書けなくても、成功の答えは 200 のまま', async () => {
    mockRecordHeartbeat.mockRejectedValue(new Error('db down'));

    const response = await POST(authorizedRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { uploads: 3, photos: 2 } });
    expect(logged).toHaveBeenCalledWith('[purge-return-photos] Failed to record heartbeat', 'Error');
  });
});
