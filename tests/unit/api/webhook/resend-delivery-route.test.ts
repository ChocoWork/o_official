/** @jest-environment node */
import { createHmac } from 'node:crypto';

// jest の共通の初期設定（tests/setupRequestPolyfill.js）が Response を node-fetch のものに差し替え、静的な json() が無い。NextResponse.json が内部で使うため補う
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

const mockRpc = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => ({ rpc: (...args: unknown[]) => mockRpc(...args) })),
}));

import { POST } from '@/app/api/webhook/resend-delivery/route';

const SECRET = `whsec_${Buffer.from('resend-delivery-test-secret').toString('base64')}`;

function sign(id: string, timestamp: string, body: string, secret = SECRET): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

function deliveryRequest(
  body: string,
  options: { id?: string; timestamp?: string; signature?: string; headers?: Record<string, string> } = {},
): Request {
  const id = options.id ?? 'msg_1';
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  return new Request('http://localhost/api/webhook/resend-delivery', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': options.signature ?? sign(id, timestamp, body),
      ...options.headers,
    },
    body,
  });
}

const DELIVERED = JSON.stringify({
  type: 'email.delivered',
  created_at: '2026-10-09T01:00:00.000Z',
  data: { email_id: 're_1', to: ['hanako@example.com'], subject: '件名' },
});

describe('POST /api/webhook/resend-delivery', () => {
  const saved = process.env.RESEND_DELIVERY_WEBHOOK_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RESEND_DELIVERY_WEBHOOK_SECRET = SECRET;
    mockRpc.mockResolvedValue({ data: 'updated', error: null });
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.RESEND_DELIVERY_WEBHOOK_SECRET;
    else process.env.RESEND_DELIVERY_WEBHOOK_SECRET = saved;
  });

  it('正しい署名の配達の知らせを、知らせの番号つきで記録して 200 を返す', async () => {
    const response = await POST(deliveryRequest(DELIVERED));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mockRpc).toHaveBeenCalledWith('record_order_email_delivery', {
      _svix_id: 'msg_1', _provider_message_id: 're_1', _delivery_status: 'delivered', _event_at: '2026-10-09T01:00:00.000Z',
    });
  });

  it('同じ知らせの2回目・知らないメールも 200 を返す（送り直させない）', async () => {
    mockRpc.mockResolvedValueOnce({ data: 'duplicate', error: null });
    expect((await POST(deliveryRequest(DELIVERED))).status).toBe(200);
    mockRpc.mockResolvedValueOnce({ data: 'unknown_email', error: null });
    expect((await POST(deliveryRequest(DELIVERED))).status).toBe(200);
  });

  it('鍵の作り直しの間に並んだ署名のどれかが合えば通す', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const old = sign('msg_1', timestamp, DELIVERED, `whsec_${Buffer.from('old').toString('base64')}`);
    const response = await POST(deliveryRequest(DELIVERED, { timestamp, signature: `${old} ${sign('msg_1', timestamp, DELIVERED)}` }));
    expect(response.status).toBe(200);
  });

  it('署名が合わない・時刻が5分より古いなら 401 で、DB に触れない', async () => {
    expect((await POST(deliveryRequest(DELIVERED, { signature: 'v1,AAAA' }))).status).toBe(401);
    const old = String(Math.floor(Date.now() / 1000) - 301);
    expect((await POST(deliveryRequest(DELIVERED, { timestamp: old, signature: sign('msg_1', old, DELIVERED) }))).status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('署名の見出しが無い・知らせの番号が長すぎるなら 400', async () => {
    const missing = new Request('http://localhost/api/webhook/resend-delivery', { method: 'POST', body: DELIVERED });
    expect((await POST(missing)).status).toBe(400);
    const longId = 'x'.repeat(201);
    expect((await POST(deliveryRequest(DELIVERED, { id: longId }))).status).toBe(400);
  });

  it('64KB を超える本文は 413', async () => {
    const big = JSON.stringify({ type: 'email.delivered', created_at: '2026-10-09T01:00:00Z', data: { email_id: 're_1', pad: 'x'.repeat(70_000) } });
    expect((await POST(deliveryRequest(big))).status).toBe(413);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('受けない種類は記録せずに 200、形の違う本文は 400', async () => {
    const opened = JSON.stringify({ type: 'email.opened', created_at: '2026-10-09T01:00:00Z', data: { email_id: 're_1' } });
    const ignored = await POST(deliveryRequest(opened));
    expect(ignored.status).toBe(200);
    await expect(ignored.json()).resolves.toEqual({ received: true, ignored: true });

    const broken = JSON.stringify({ type: 'email.delivered', created_at: '2026-10-09T01:00:00Z', data: {} });
    expect((await POST(deliveryRequest(broken))).status).toBe(400);
    expect((await POST(deliveryRequest('not json'))).status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('鍵が無ければ 503、DB の失敗は 500（Svix が送り直す）', async () => {
    delete process.env.RESEND_DELIVERY_WEBHOOK_SECRET;
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect((await POST(deliveryRequest(DELIVERED))).status).toBe(503);

    process.env.RESEND_DELIVERY_WEBHOOK_SECRET = SECRET;
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'down', code: '08006' } });
    expect((await POST(deliveryRequest(DELIVERED))).status).toBe(500);
    error.mockRestore();
  });
});
