/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
const mockCsrf = jest.fn();
const mockRateLimit = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: () => mockCsrf() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockRateLimit(...args) }));
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermissions: jest.fn(), authorizeAdminPermission: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockLogAudit = jest.fn();
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));

import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import * as reservationsRoute from '@/app/api/admin/purchase-orders/[id]/attachments/reservations/route';
import * as uploadUrlRoute from '@/app/api/admin/purchase-orders/[id]/attachments/reservations/[reservationId]/upload-url/route';
import * as attachmentsRoute from '@/app/api/admin/purchase-orders/[id]/attachments/route';
import * as revisionsRoute from '@/app/api/admin/purchase-orders/[id]/attachments/[attachmentId]/revisions/route';
import * as urlRoute from '@/app/api/admin/purchase-orders/[id]/attachments/[attachmentId]/url/route';
import { authorizeAdminPermission, authorizeAdminPermissions } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { ATTACHMENT_ID, confirmedDetail, ORDER_ID, RESERVATION_ID } from '../../lib/purchase-orders/purchase-order-fixtures';

const OBJECT_NAME = '99999999-9999-4999-8999-999999999999.pdf';
const STORAGE_PATH = `${ORDER_ID}/${OBJECT_NAME}`;
const SIGNED_UPLOAD = 'https://storage.example.test/object/upload/sign/purchase-order-documents/SECRET-UPLOAD-TOKEN';
const SIGNED_VIEW = 'https://storage.example.test/object/sign/purchase-order-documents/SECRET-VIEW-TOKEN';
const REQUEST_KEY = '11111111-1111-4111-8111-111111111111';
const PDF = new Uint8Array(Buffer.from('%PDF-1.4 sample document'));
const PDF_SHA = createHash('sha256').update(PDF).digest('hex');
const SECRETS = ['SECRET-UPLOAD-TOKEN', 'SECRET-VIEW-TOKEN', OBJECT_NAME, STORAGE_PATH, 'storage.example.test', 'sample document', 'invoice.pdf'];

const rpc = jest.fn();
const bucket = { createSignedUploadUrl: jest.fn(), list: jest.fn(), download: jest.fn(), createSignedUrl: jest.fn() };
const tables: Record<string, unknown> = {};
const from = jest.fn((table: string) => tables[table]);
const authorize = authorizeAdminPermissions as jest.Mock;
const authorizeOne = authorizeAdminPermission as jest.Mock;

function queryOf(data: unknown, error: unknown = null) {
  const builder: Record<string, unknown> = {};
  builder.select = jest.fn(() => builder);
  builder.eq = jest.fn(() => builder);
  builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve({ data, error }).then(resolve, reject);
  return builder;
}

const RESERVATIONS = 'purchase_order_attachment_reservations';
const ATTACHMENTS = 'purchase_order_attachments';

/** 本物の authorizeAdminPermissions と同じ規則の代役: 要る権限を全部持つ時だけ通し、足りない最初の権限を 403 に入れる */
function mockAcl(granted: readonly string[]) {
  const deny = (missing: string) => ({ ok: false, response: new Response(JSON.stringify({ error: 'Forbidden', permission: missing, role: 'supporter' }), { status: 403 }) });
  authorize.mockImplementation(async (required: readonly string[]) => {
    const missing = required.find((code) => !granted.includes(code));
    return missing === undefined ? { ok: true, userId: 'authorized-actor', role: 'supporter' } : deny(missing);
  });
  authorizeOne.mockImplementation(async (required: string) =>
    granted.includes(required) ? { ok: true, userId: 'authorized-actor', role: 'supporter' } : deny(required));
}

/** get_admin_purchase_order は読める発注書を返し、それ以外の RPC は個別に決める */
function mockRpcWithOrder(other: (name: string, args: Record<string, unknown>) => unknown = () => ({ data: null, error: null })) {
  rpc.mockImplementation(async (name: string, args: Record<string, unknown>) =>
    name === 'get_admin_purchase_order' ? { data: confirmedDetail(), error: null } : other(name, args));
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  for (const key of Object.keys(tables)) delete tables[key];
  from.mockImplementation((table: string) => tables[table]);
  authorize.mockResolvedValue({ ok: true, userId: 'authorized-actor', role: 'admin' });
  authorizeOne.mockResolvedValue({ ok: true, userId: 'authorized-actor', role: 'admin' });
  mockCsrf.mockResolvedValue(undefined);
  mockRateLimit.mockResolvedValue(null);
  mockLogAudit.mockResolvedValue(undefined);
  (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc, from, storage: { from: () => bucket } });
});
afterEach(() => jest.restoreAllMocks());

function jsonRequest(url: string, body: unknown, method = 'POST'): Request {
  return new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

const base = (id: string = ORDER_ID) => `https://example.test/api/admin/purchase-orders/${id}/attachments`;

async function read(response: Response) {
  const text = await response.text();
  return { response, status: response.status, text, json: text ? JSON.parse(text) : null };
}

const noSecret = (value: unknown) => {
  const text = inspect(value, { depth: null });
  for (const secret of SECRETS) expect(text).not.toContain(secret);
};

const DENIALS = [
  ['admin.items.read と admin.items.manage だけ', ['admin.items.read', 'admin.items.manage'], 'admin.purchase_orders.manage'],
  ['admin.purchase_orders.read だけ', ['admin.purchase_orders.read'], 'admin.purchase_orders.manage'],
  ['admin.purchase_orders.manage だけ', ['admin.purchase_orders.manage'], 'admin.purchase_orders.read'],
  ['admin.receiving.manage と admin.stock.manage だけ', ['admin.receiving.manage', 'admin.stock.manage'], 'admin.purchase_orders.manage'],
] as const;

const WRITE_PERMISSIONS = ['admin.purchase_orders.manage', 'admin.purchase_orders.read'];

/** 認可・CSRF・回数制限・id の共通の作法（POST 4本が同じ）。run は本文つきで呼び出す関数 */
function commonWriteTests(name: string, action: string, limit: number, call: (body?: unknown, ids?: Record<string, string>) => Promise<Response>, validBody: unknown, arrange: () => void) {
  describe(`${name}: 認可・CSRF・回数制限・パスの id`, () => {
    beforeEach(arrange);

    test.each(DENIALS)('FREQ-540-AC-07: %s の人は 403（足りない最初の権限が permission）で no-store。CSRF・制限・置き場・DB には進まない', async (_name, held, missing) => {
      mockAcl(held);
      const { response, status, json } = await read(await call(validBody));
      expect(status).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(json).toEqual({ error: 'Forbidden', permission: missing, role: 'supporter' });
      for (const mock of [mockCsrf, mockRateLimit, createServiceRoleClient, rpc, bucket.createSignedUploadUrl, bucket.download, mockLogAudit]) expect(mock).not.toHaveBeenCalled();
    });

    test('FREQ-540-AC-07: manage と read の両方があれば進む', async () => {
      mockAcl(WRITE_PERMISSIONS);
      expect((await call(validBody)).status).toBeLessThan(300);
    });

    test.each([
      [401, { error: 'Unauthorized' }], [403, { error: 'Forbidden', reason: 'MFA required' }], [503, { error: 'Service temporarily unavailable' }],
    ])('FREQ-540-AC-07: 認可の拒否 %s は状態と本文をそのまま返し no-store。CSRF より前で止まる', async (status, body) => {
      authorize.mockResolvedValue({ ok: false, response: new Response(JSON.stringify(body), { status, headers: { 'retry-after': '30' } }) });
      const result = await read(await call(validBody));
      expect(result.status).toBe(status);
      expect(result.json).toEqual(body);
      expect(result.response.headers.get('cache-control')).toBe('no-store');
      expect(mockCsrf).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    });

    test(`FREQ-530-AC-02: 認可は ${WRITE_PERMISSIONS.join(' + ')} の組。回数制限は ${action} の ${limit} 回/600 秒を IP と actor（認可結果の userId）の2回`, async () => {
      await call(validBody);
      expect(authorize).toHaveBeenCalledWith(WRITE_PERMISSIONS, expect.anything());
      expect(mockRateLimit).toHaveBeenCalledTimes(2);
      expect(mockRateLimit).toHaveBeenNthCalledWith(1, expect.objectContaining({ endpoint: action, limit, windowSeconds: 600 }));
      expect(mockRateLimit.mock.calls[0][0]).not.toHaveProperty('subject');
      expect(mockRateLimit).toHaveBeenNthCalledWith(2, expect.objectContaining({ endpoint: action, limit, windowSeconds: 600, subject: 'authorized-actor' }));
    });

    test('FREQ-530-AC-02: CSRF の拒否・回数制限（IP・actor）の Response はそのまま返し、置き場にも DB にも進まない', async () => {
      const denied = new Response('Denied', { status: 403 });
      mockCsrf.mockResolvedValue(denied);
      expect(await call(validBody)).toBe(denied);
      mockCsrf.mockResolvedValue(undefined);
      for (const stage of [1, 2]) {
        const limited = new Response('Limited', { status: 429 });
        if (stage === 2) mockRateLimit.mockResolvedValueOnce(null);
        mockRateLimit.mockResolvedValueOnce(limited);
        expect(await call(validBody)).toBe(limited);
      }
      expect(rpc).not.toHaveBeenCalled();
      expect(bucket.createSignedUploadUrl).not.toHaveBeenCalled();
      expect(bucket.download).not.toHaveBeenCalled();
    });

    test.each(['abc', '123', 'not-a-uuid', '../orders'])('FREQ-530-AC-02: 発注書の id が uuid でない（%s）は 400 で no-store。置き場にも DB にも進まず、監査の resource_id は null（受け取った文字列は残さない）', async (id) => {
      const { response, status, json } = await read(await call(validBody, { id }));
      expect(status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(json).toEqual({ error: 'Invalid request' });
      expect(rpc).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', resource_id: null, metadata: { code: 'INVALID_REQUEST' } }));
      expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain(id);
    });

    test('FREQ-530-AC-02: 想定外の throw は名前と code だけをログに残し、固定の500を返す', async () => {
      authorize.mockRejectedValue(Object.assign(new TypeError('PRIVATE-MARKER'), { code: 'XX000' }));
      const result = await read(await call(validBody));
      expect(result.status).toBe(500);
      expect(result.json).toEqual({ error: '発注の記録に失敗しました' });
      expect(inspect((console.error as jest.Mock).mock.calls, { depth: null })).not.toContain('PRIVATE-MARKER');
      expect(rpc).not.toHaveBeenCalled();
    });
  });
}

// ---- POST .../attachments/reservations ----

describe('POST /api/admin/purchase-orders/[id]/attachments/reservations（置き場の予約）', () => {
  const body = { kind: 'invoice', fileName: 'invoice.pdf', requestKey: REQUEST_KEY };
  const dbResult = { reservationId: RESERVATION_ID, storagePath: STORAGE_PATH, expiresAt: '2026-10-26T12:00:00+00:00', replayed: false };
  const post = (payload: unknown = body, ids: Record<string, string> = {}) =>
    reservationsRoute.POST(jsonRequest(base(ids.id), payload), { params: Promise.resolve({ id: ids.id ?? ORDER_ID }) });
  const arrange = () => {
    rpc.mockResolvedValue({ data: dbResult, error: null });
    bucket.createSignedUploadUrl.mockResolvedValue({ data: { signedUrl: SIGNED_UPLOAD }, error: null });
  };

  commonWriteTests('予約', 'admin.purchase_orders.attachment.reserve', 30, post, body, arrange);

  describe('成功・検証・失敗', () => {
    beforeEach(arrange);

    test('FREQ-530-AC-03: 201 で { reservationId, signedUrl, expiresAt, replayed } を返し no-store。署名つきの送り先は上書きできない形。実行者は認可結果だけから渡す', async () => {
      const result = await read(await post({ ...body, actorId: 'forged' }));
      expect(result.status).toBe(201);
      expect(result.response.headers.get('cache-control')).toBe('no-store');
      expect(result.json).toEqual({ reservationId: RESERVATION_ID, signedUrl: SIGNED_UPLOAD, expiresAt: dbResult.expiresAt, replayed: false });
      expect(rpc).toHaveBeenCalledWith('admin_reserve_purchase_order_attachment', {
        _purchase_order_id: ORDER_ID, _kind: 'invoice', _file_name: 'invoice.pdf', _replaces_attachment_id: null, _actor_id: 'authorized-actor', _request_key: REQUEST_KEY,
      });
      expect(bucket.createSignedUploadUrl).toHaveBeenCalledWith(STORAGE_PATH, { upsert: false });
    });

    test('FREQ-530-AC-03: 差し替えの予約は、差し替える添付の id を DB の予約に残すために渡す（null・省略は新しい書類）。uuid でなければ400で、DB にも置き場にも進まない', async () => {
      await post({ ...body, replacesAttachmentId: ATTACHMENT_ID });
      expect(rpc).toHaveBeenLastCalledWith('admin_reserve_purchase_order_attachment', expect.objectContaining({ _replaces_attachment_id: ATTACHMENT_ID }));
      await post({ ...body, replacesAttachmentId: null });
      expect(rpc).toHaveBeenLastCalledWith('admin_reserve_purchase_order_attachment', expect.objectContaining({ _replaces_attachment_id: null }));
      await post(body);
      expect(rpc).toHaveBeenLastCalledWith('admin_reserve_purchase_order_attachment', expect.objectContaining({ _replaces_attachment_id: null }));
      rpc.mockClear();
      bucket.createSignedUploadUrl.mockClear();
      const invalid = await read(await post({ ...body, replacesAttachmentId: 'x' }));
      expect(invalid.status).toBe(400);
      expect(rpc).not.toHaveBeenCalled();
      expect(bucket.createSignedUploadUrl).not.toHaveBeenCalled();
    });

    test('FREQ-530-AC-03: 差し替えの予約の監査は 再送かどうかだけ（差し替え元の id は残さない）', async () => {
      await post({ ...body, replacesAttachmentId: ATTACHMENT_ID });
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', metadata: { replayed: false } }));
      expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain(ATTACHMENT_ID);
    });

    test('FREQ-530-AC-03: ファイル名は前後の空白を落として渡す。同じ要求の再送（replayed: true）も201', async () => {
      rpc.mockResolvedValue({ data: { ...dbResult, replayed: true }, error: null });
      const result = await read(await post({ ...body, fileName: '  invoice.pdf  ' }));
      expect(result.status).toBe(201);
      expect(result.json.replayed).toBe(true);
      expect(rpc).toHaveBeenCalledWith('admin_reserve_purchase_order_attachment', expect.objectContaining({ _file_name: 'invoice.pdf' }));
    });

    test('FREQ-530-AC-03: 認可 → CSRF → IP → actor → 検証 → DB → 置き場 → 監査 の順。検証で落ちた時は監査まで', async () => {
      const order: string[] = [];
      authorize.mockImplementation(async () => { order.push('authorize'); return { ok: true, userId: 'authorized-actor', role: 'admin' }; });
      mockCsrf.mockImplementation(async () => { order.push('csrf'); });
      mockRateLimit.mockImplementation(async (arg: { subject?: string }) => { order.push(arg.subject ? 'rate:actor' : 'rate:ip'); return null; });
      rpc.mockImplementation(async () => { order.push('rpc'); return { data: dbResult, error: null }; });
      bucket.createSignedUploadUrl.mockImplementation(async () => { order.push('storage'); return { data: { signedUrl: SIGNED_UPLOAD }, error: null }; });
      mockLogAudit.mockImplementation(async () => { order.push('audit'); });
      expect((await post()).status).toBe(201);
      expect(order).toEqual(['authorize', 'csrf', 'rate:ip', 'rate:actor', 'rpc', 'storage', 'audit']);
      order.length = 0;
      expect((await post({ ...body, kind: 'memo' })).status).toBe(400);
      expect(order).toEqual(['authorize', 'csrf', 'rate:ip', 'rate:actor', 'audit']);
    });

    test('FREQ-530-AC-03: 監査 admin.purchase_orders.attachment.reserve は発注書の id と再送かどうかだけ。署名つきの送り先・保存キー・ファイル名・要求番号は残さない', async () => {
      await post();
      expect(mockLogAudit).toHaveBeenCalledTimes(1);
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'admin.purchase_orders.attachment.reserve', actor_id: 'authorized-actor', resource: 'purchase_orders', resource_id: ORDER_ID,
        outcome: 'success', metadata: { replayed: false },
      });
      noSecret(mockLogAudit.mock.calls);
      expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain(REQUEST_KEY);
    });

    test.each([
      ['種類が無い', { ...body, kind: undefined }],
      ['種類が quote・invoice 以外', { ...body, kind: 'memo' }],
      ['ファイル名が無い', { ...body, fileName: undefined }],
      ['ファイル名が空白だけ', { ...body, fileName: '   ' }],
      ['ファイル名が256字', { ...body, fileName: `${'a'.repeat(252)}.pdf` }],
      ['requestKey が uuid でない', { ...body, requestKey: 'invalid' }],
      ['本文が JSON でない', 'not json'],
    ])('FREQ-530-AC-02: 検証 %s は 400 で、置き場にも DB にも進まない。監査は failure と結果コードだけ', async (_name, payload) => {
      const { response, status } = await read(await post(payload));
      expect(status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(rpc).not.toHaveBeenCalled();
      expect(bucket.createSignedUploadUrl).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', metadata: { code: 'INVALID_REQUEST' } }));
    });

    test('FREQ-530-AC-02: ファイル名が255字ちょうどは通る', async () => {
      expect((await post({ ...body, fileName: `${'a'.repeat(251)}.pdf` })).status).toBe(201);
    });

    test.each([
      ['GROUP_G_ARGUMENT_INVALID', '22023', 400, '入力を確かめてください。'],
      ['GROUP_G_FORBIDDEN', '42501', 403, '発注を扱う権限がありません。'],
      ['GROUP_G_PO_NOT_FOUND', 'P0002', 404, '発注書が見つかりません。'],
      ['GROUP_G_PO_DOCUMENT_REPLACEMENT_INVALID', '22023', 400, '差し替え元の書類を確かめてください。'],
      ['GROUP_G_REQUEST_KEY_CONFLICT', '23505', 409, '同じ要求番号で異なる操作は実行できません。'],
    ])('FREQ-530-AC-02: DB の %s（%s）は %i と本文を { code, error } で返し、置き場には進まない。監査は failure と結果コードだけ', async (message, sqlstate, status, text) => {
      rpc.mockResolvedValue({ data: null, error: { message, code: sqlstate, details: 'PRIVATE-MARKER' } });
      const result = await read(await post());
      expect(result.status).toBe(status);
      expect(result.json).toEqual({ code: message, error: text });
      expect(result.text).not.toContain('PRIVATE-MARKER');
      expect(bucket.createSignedUploadUrl).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', metadata: { code: message } }));
    });

    test('FREQ-530-AC-03: 送り先を作れなかった時は503の { code, error } で、予約は DB に残る。応答にも監査にもログにも署名つきの送り先・保存キーが無い', async () => {
      bucket.createSignedUploadUrl.mockResolvedValue({ data: null, error: { message: `boom ${SIGNED_UPLOAD} ${STORAGE_PATH}` } });
      const result = await read(await post());
      expect(result.status).toBe(503);
      expect(result.json).toEqual({ code: 'DOCUMENT_STORAGE_UNAVAILABLE', error: 'ファイルの保存先に接続できません。時間をおいて再度お試しください。' });
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', metadata: { code: 'DOCUMENT_STORAGE_UNAVAILABLE' } }));
      noSecret([result.text, mockLogAudit.mock.calls, (console.error as jest.Mock).mock.calls]);
    });

    test('FREQ-530-AC-03: 未知の DB エラーは固定の500で、生の文を本文にも監査にもログにも出さない', async () => {
      rpc.mockResolvedValue({ data: null, error: { message: 'PRIVATE-MARKER', code: '23514', details: 'PRIVATE-MARKER' } });
      const result = await read(await post());
      expect(result.status).toBe(500);
      expect(result.json).toEqual({ error: '発注の記録に失敗しました' });
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', metadata: { code: 'PURCHASE_ORDER_ATTACHMENT_RESERVE_FAILED' } }));
      expect(inspect([result.text, mockLogAudit.mock.calls, (console.error as jest.Mock).mock.calls], { depth: null })).not.toContain('PRIVATE-MARKER');
    });
  });

  test('FREQ-530-AC-01: route file は POST だけを export する（DELETE・PUT・PATCH・GET は無い）', () => {
    expect(Object.keys(reservationsRoute).sort()).toEqual(['POST']);
  });
});

// ---- POST .../attachments/reservations/[reservationId]/upload-url ----

describe('POST /api/admin/purchase-orders/[id]/attachments/reservations/[reservationId]/upload-url（署名つき送り先の出し直し）', () => {
  const post = (payload: unknown = undefined, ids: Record<string, string> = {}) => uploadUrlRoute.POST(
    new Request(`${base(ids.id)}/reservations/${ids.reservationId ?? RESERVATION_ID}/upload-url`, payload === undefined ? { method: 'POST' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    { params: Promise.resolve({ id: ids.id ?? ORDER_ID, reservationId: ids.reservationId ?? RESERVATION_ID }) },
  );
  const arrange = (stored = false, attached = false, reserved = true) => {
    mockRpcWithOrder();
    tables[RESERVATIONS] = queryOf(reserved ? [{ storage_path: STORAGE_PATH }] : []);
    tables[ATTACHMENTS] = queryOf(attached ? [{ id: ATTACHMENT_ID }] : []);
    bucket.list.mockResolvedValue({ data: stored ? [{ name: OBJECT_NAME }] : [], error: null });
    bucket.createSignedUploadUrl.mockResolvedValue({ data: { signedUrl: SIGNED_UPLOAD }, error: null });
  };

  commonWriteTests('送り先の出し直し', 'admin.purchase_orders.attachment.upload_url', 30, post, undefined, () => arrange());

  describe('成功・失敗', () => {
    test('FREQ-530-AC-03: 置き場に無ければ 200 { uploaded: false, signedUrl }（新しい送り先は上書きできない形）。本文は要らない', async () => {
      arrange();
      const result = await read(await post());
      expect(result.status).toBe(200);
      expect(result.response.headers.get('cache-control')).toBe('no-store');
      expect(result.json).toEqual({ uploaded: false, signedUrl: SIGNED_UPLOAD });
      expect(bucket.createSignedUploadUrl).toHaveBeenCalledWith(STORAGE_PATH, { upsert: false });
    });

    test('FREQ-530-AC-03: 置き場に保存済みなら 200 { uploaded: true }。送り先は作らない。本文に余計な項目があっても読まない', async () => {
      arrange(true);
      const result = await read(await post({ reservationId: 'ignored', actorId: 'forged' }));
      expect(result.status).toBe(200);
      expect(result.json).toEqual({ uploaded: true });
      expect(bucket.createSignedUploadUrl).not.toHaveBeenCalled();
    });

    test('FREQ-540-AC-07: 最初に get_admin_purchase_order を実行者つきで呼ぶ。DB が 42501 で断れば 403、発注書が無ければ 404（予約の表にも置き場にも進まない）', async () => {
      arrange();
      rpc.mockResolvedValueOnce({ data: null, error: { message: 'GROUP_G_FORBIDDEN', code: '42501' } });
      const forbidden = await read(await post());
      expect(forbidden.status).toBe(403);
      expect(forbidden.json).toEqual({ code: 'GROUP_G_FORBIDDEN', error: '発注を扱う権限がありません。' });
      rpc.mockResolvedValueOnce({ data: null, error: null });
      const missing = await read(await post());
      expect(missing.status).toBe(404);
      expect(missing.json).toEqual({ code: 'GROUP_G_PO_NOT_FOUND', error: '発注書が見つかりません。' });
      expect(rpc).toHaveBeenNthCalledWith(1, 'get_admin_purchase_order', { _purchase_order_id: ORDER_ID, _actor_id: 'authorized-actor' });
      expect(from).not.toHaveBeenCalled();
      expect(bucket.list).not.toHaveBeenCalled();
    });

    test.each([
      ['予約が当発注書の物でない', () => arrange(false, false, false), 'GROUP_G_PO_DOCUMENT_RESERVATION_INVALID', '保存の予約が見つかりません。もう一度ファイルを選んでください。'],
      ['すでに添付に結ばれている', () => arrange(false, true), 'GROUP_G_PO_DOCUMENT_ALREADY_ATTACHED', 'この書類はすでに登録されています。'],
    ])('FREQ-530-AC-03: %s は 409 { code, error }。置き場には進まない', async (_name, setup, code, text) => {
      setup();
      const result = await read(await post());
      expect(result.status).toBe(409);
      expect(result.json).toEqual({ code, error: text });
      expect(bucket.list).not.toHaveBeenCalled();
    });

    test('FREQ-530-AC-03: 置き場の一覧が失敗した時は503で、応答にも監査にもログにも署名つきの送り先・保存キーが無い', async () => {
      arrange();
      bucket.list.mockResolvedValue({ data: null, error: { message: STORAGE_PATH } });
      const result = await read(await post());
      expect(result.status).toBe(503);
      expect(result.json).toMatchObject({ code: 'DOCUMENT_STORAGE_UNAVAILABLE' });
      noSecret([result.text, mockLogAudit.mock.calls, (console.error as jest.Mock).mock.calls]);
    });

    test('FREQ-530-AC-03: 予約の uuid が uuid でなければ 400。監査の resource_id は発注書の id', async () => {
      arrange();
      const result = await read(await post(undefined, { reservationId: 'not-a-uuid' }));
      expect(result.status).toBe(400);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', resource_id: ORDER_ID, metadata: { code: 'INVALID_REQUEST' } }));
      expect(rpc).not.toHaveBeenCalled();
    });

    test('FREQ-530-AC-03: 監査 admin.purchase_orders.attachment.upload_url は id と保存済みかどうかだけ。署名つきの送り先は残さない', async () => {
      arrange();
      await post();
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'admin.purchase_orders.attachment.upload_url', actor_id: 'authorized-actor', resource: 'purchase_orders', resource_id: ORDER_ID,
        outcome: 'success', metadata: { uploaded: false },
      });
      noSecret(mockLogAudit.mock.calls);
    });
  });

  test('FREQ-530-AC-01: route file は POST だけを export する', () => {
    expect(Object.keys(uploadUrlRoute).sort()).toEqual(['POST']);
  });
});

// ---- POST .../attachments ----

describe('POST /api/admin/purchase-orders/[id]/attachments（確定）', () => {
  const body = {
    reservationId: RESERVATION_ID, sha256: PDF_SHA, transactionDate: '2026-10-26', amountYen: 6000, currency: 'JPY', counterparty: '工場A',
    requestKey: REQUEST_KEY,
  };
  const dbResult = { attachmentId: ATTACHMENT_ID, revisionNo: 1, replayed: false };
  const post = (payload: unknown = body, ids: Record<string, string> = {}) =>
    attachmentsRoute.POST(jsonRequest(base(ids.id), payload), { params: Promise.resolve({ id: ids.id ?? ORDER_ID }) });
  const arrange = () => {
    tables[RESERVATIONS] = queryOf([{ storage_path: STORAGE_PATH }]);
    bucket.download.mockResolvedValue({ data: { type: 'application/pdf', arrayBuffer: async () => PDF.buffer.slice(PDF.byteOffset, PDF.byteOffset + PDF.byteLength) }, error: null });
    rpc.mockResolvedValue({ data: dbResult, error: null });
  };

  commonWriteTests('確定', 'admin.purchase_orders.attachment.attach', 30, post, body, arrange);

  describe('成功・検証・失敗', () => {
    beforeEach(arrange);

    test('FREQ-530-AC-02: 201 で { attachmentId, revisionNo, replayed } を返し no-store。読み戻した本文の検査の結果を DB へ渡し、実行者は認可結果だけから渡す', async () => {
      const result = await read(await post({ ...body, actorId: 'forged' }));
      expect(result.status).toBe(201);
      expect(result.response.headers.get('cache-control')).toBe('no-store');
      expect(result.json).toEqual(dbResult);
      expect(bucket.download).toHaveBeenCalledWith(STORAGE_PATH);
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith('admin_attach_purchase_order_document', {
        _reservation_id: RESERVATION_ID, _purchase_order_id: ORDER_ID, _mime_type: 'application/pdf', _size_bytes: PDF.length, _sha256: PDF_SHA,
        _sha256_source: 'browser', _transaction_date: '2026-10-26', _amount_yen: 6000, _currency: 'JPY', _counterparty: '工場A',
        _actor_id: 'authorized-actor', _request_key: REQUEST_KEY,
      });
    });

    test('FREQ-530-AC-03: sha256: null（ページを読み直した後の再開）は sha256_source=server。取引先は空白を落とす', async () => {
      await post({ ...body, sha256: null, counterparty: '  工場A  ' });
      expect(rpc).toHaveBeenLastCalledWith('admin_attach_purchase_order_document', expect.objectContaining({
        _sha256: PDF_SHA, _sha256_source: 'server', _counterparty: '工場A',
      }));
    });

    test('FREQ-530-AC-03: 差し替え元は本文では受けない。予約に残した物を DB が版1へ写すので、本文に replacesAttachmentId が来ても DB の関数へ渡さない（頁を読み直しても関係が変わらない）', async () => {
      const result = await read(await post({ ...body, replacesAttachmentId: ATTACHMENT_ID }));
      expect(result.status).toBe(201);
      const [, args] = rpc.mock.calls[0];
      expect(Object.keys(args as object)).not.toContain('_replaces_attachment_id');
      expect(JSON.stringify(args)).not.toContain(ATTACHMENT_ID);
    });

    test('FREQ-530-AC-03: 同じ要求の再送（replayed: true）も201', async () => {
      rpc.mockResolvedValue({ data: { ...dbResult, replayed: true }, error: null });
      const result = await read(await post());
      expect(result.status).toBe(201);
      expect(result.json.replayed).toBe(true);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'success', metadata: { reservation_id: RESERVATION_ID, attachment_id: ATTACHMENT_ID, replayed: true },
      }));
    });

    test('FREQ-530-AC-03: 認可 → CSRF → IP → actor → 検証 → 置き場の読み戻し → DB → 監査 の順（DB の取引の中では置き場を使わない）', async () => {
      const order: string[] = [];
      authorize.mockImplementation(async () => { order.push('authorize'); return { ok: true, userId: 'authorized-actor', role: 'admin' }; });
      mockCsrf.mockImplementation(async () => { order.push('csrf'); });
      mockRateLimit.mockImplementation(async (arg: { subject?: string }) => { order.push(arg.subject ? 'rate:actor' : 'rate:ip'); return null; });
      bucket.download.mockImplementation(async () => { order.push('download'); return { data: { type: 'application/pdf', arrayBuffer: async () => PDF.buffer.slice(PDF.byteOffset, PDF.byteOffset + PDF.byteLength) }, error: null }; });
      rpc.mockImplementation(async () => { order.push('rpc'); return { data: dbResult, error: null }; });
      mockLogAudit.mockImplementation(async () => { order.push('audit'); });
      expect((await post()).status).toBe(201);
      expect(order).toEqual(['authorize', 'csrf', 'rate:ip', 'rate:actor', 'download', 'rpc', 'audit']);
    });

    test('FREQ-530-AC-02: 監査 admin.purchase_orders.attachment.attach は発注書・予約・添付の id と再送かどうかだけ（取引先・金額・ハッシュ・要求番号は残さない）', async () => {
      await post();
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'admin.purchase_orders.attachment.attach', actor_id: 'authorized-actor', resource: 'purchase_orders', resource_id: ORDER_ID,
        outcome: 'success', metadata: { reservation_id: RESERVATION_ID, attachment_id: ATTACHMENT_ID, replayed: false },
      });
      const logged = JSON.stringify(mockLogAudit.mock.calls);
      for (const value of ['工場A', PDF_SHA, REQUEST_KEY, '6000']) expect(logged).not.toContain(value);
    });

    test.each([
      ['予約 ID が uuid でない', { ...body, reservationId: 'x' }],
      ['sha256 の項目が無い', { ...body, sha256: undefined }],
      ['sha256 が大文字', { ...body, sha256: PDF_SHA.toUpperCase() }],
      ['sha256 が63桁', { ...body, sha256: PDF_SHA.slice(1) }],
      ['sha256 が数', { ...body, sha256: 1 }],
      ['取引日が実在しない', { ...body, transactionDate: '2026-02-30' }],
      ['取引日が形違い', { ...body, transactionDate: '2026/10/26' }],
      ['取引日が 2000-01-01 より前', { ...body, transactionDate: '1999-12-31' }],
      ['金額が負', { ...body, amountYen: -1 }],
      ['金額が小数', { ...body, amountYen: 1.5 }],
      ['金額が文字', { ...body, amountYen: '6000' }],
      ['金額が上限超え', { ...body, amountYen: 100000000000 }],
      ['通貨が JPY でない', { ...body, currency: 'USD' }],
      ['通貨が無い', { ...body, currency: undefined }],
      ['取引先が空白だけ', { ...body, counterparty: '   ' }],
      ['取引先が101字', { ...body, counterparty: 'あ'.repeat(101) }],
      ['requestKey が無い', { ...body, requestKey: undefined }],
      ['本文が JSON でない', 'not json'],
    ])('FREQ-530-AC-02: 検証 %s は 400 で、置き場にも DB にも進まない。監査は failure と結果コードだけ', async (_name, payload) => {
      const { response, status, json } = await read(await post(payload));
      expect(status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(json.error).toBe('Invalid request');
      expect(bucket.download).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', resource_id: ORDER_ID, metadata: { code: 'INVALID_REQUEST' } }));
    });

    test('FREQ-530-AC-02: 上限ちょうど（金額 99999999999・取引日 2000-01-01・取引先100字・金額0）は通る', async () => {
      expect((await post({ ...body, amountYen: 99999999999, transactionDate: '2000-01-01', counterparty: 'あ'.repeat(100) })).status).toBe(201);
      expect((await post({ ...body, amountYen: 0 })).status).toBe(201);
    });

    test('FREQ-530-AC-02: 取引日は未来でもよい', async () => {
      expect((await post({ ...body, transactionDate: '2099-12-31' })).status).toBe(201);
    });

    test.each([
      ['置き場にまだ無い', () => bucket.download.mockResolvedValue({ data: null, error: { status: 400, statusCode: '404', message: STORAGE_PATH } }), 409, 'DOCUMENT_NOT_UPLOADED', 'ファイルがまだ届いていません。もう一度アップロードしてください。'],
      ['種類が合わない', () => bucket.download.mockResolvedValue({ data: { type: 'application/pdf', arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer }, error: null }), 422, 'DOCUMENT_TYPE_UNSUPPORTED', 'PDF・JPEG・PNG のファイルを選んでください。'],
      ['大きすぎる', () => bucket.download.mockResolvedValue({ data: { type: 'application/pdf', arrayBuffer: async () => { const big = new Uint8Array(20971521); big.set(PDF); return big.buffer; } }, error: null }), 422, 'DOCUMENT_TOO_LARGE', 'ファイルは 20 MiB までです。'],
      ['ハッシュが一致しない', () => { body.sha256 = 'b'.repeat(64); }, 422, 'DOCUMENT_HASH_MISMATCH', 'アップロードしたファイルの内容が一致しません。もう一度アップロードしてください。'],
      ['置き場の不調', () => bucket.download.mockResolvedValue({ data: null, error: { status: 502, message: STORAGE_PATH } }), 503, 'DOCUMENT_STORAGE_UNAVAILABLE', 'ファイルの保存先に接続できません。時間をおいて再度お試しください。'],
    ])('FREQ-530-AC-02: 原本の検査 %s は %i { code: %s, error } で、DB の関数を呼ばない。応答・監査・ログに保存キー・中身が無い', async (_name, setup, status, code, text) => {
      const saved = body.sha256;
      try {
        setup();
        const result = await read(await post());
        expect(result.status).toBe(status);
        expect(result.json).toEqual({ code, error: text });
        expect(rpc).not.toHaveBeenCalled();
        expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', metadata: { reservation_id: RESERVATION_ID, code } }));
        noSecret([result.text, mockLogAudit.mock.calls, (console.error as jest.Mock).mock.calls]);
      } finally {
        body.sha256 = saved;
      }
    });

    test.each([
      ['GROUP_G_PO_DOCUMENT_RESERVATION_INVALID', '55000', 409, '保存の予約が見つかりません。もう一度ファイルを選んでください。'],
      ['GROUP_G_PO_DOCUMENT_ALREADY_ATTACHED', '55000', 409, 'この書類はすでに登録されています。'],
      ['GROUP_G_FORBIDDEN', '42501', 403, '発注を扱う権限がありません。'],
      ['GROUP_G_PO_NOT_FOUND', 'P0002', 404, '発注書が見つかりません。'],
      ['GROUP_G_REQUEST_KEY_CONFLICT', '23505', 409, '同じ要求番号で異なる操作は実行できません。'],
    ])('FREQ-530-AC-02: DB の %s（%s）は %i と本文を { code, error } で返す。生の文は出さない。監査の失敗は予約の id と結果コード', async (message, sqlstate, status, text) => {
      rpc.mockResolvedValue({ data: null, error: { message, code: sqlstate, details: 'PRIVATE-MARKER' } });
      const result = await read(await post());
      expect(result.status).toBe(status);
      expect(result.json).toEqual({ code: message, error: text });
      expect(result.text).not.toContain('PRIVATE-MARKER');
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', metadata: { reservation_id: RESERVATION_ID, code: message } }));
    });

    test('FREQ-530-AC-02: 予約が当発注書の物でない（予約の表に行が無い）は 409 で、置き場にも DB にも進まない', async () => {
      tables[RESERVATIONS] = queryOf([]);
      const result = await read(await post());
      expect(result.status).toBe(409);
      expect(result.json.code).toBe('GROUP_G_PO_DOCUMENT_RESERVATION_INVALID');
      expect(bucket.download).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    });

    test('FREQ-530-AC-02: 未知の DB エラー・戻り値の崩れは固定の500で、生の文を出さない', async () => {
      rpc.mockResolvedValue({ data: null, error: { message: 'PRIVATE-MARKER', code: '23514' } });
      const unknown = await read(await post());
      expect(unknown.status).toBe(500);
      expect(unknown.json).toEqual({ error: '発注の記録に失敗しました' });
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'error', metadata: { reservation_id: RESERVATION_ID, code: 'PURCHASE_ORDER_ATTACHMENT_ATTACH_FAILED' },
      }));
      rpc.mockResolvedValue({ data: { attachmentId: ATTACHMENT_ID, revisionNo: 3, replayed: false }, error: null });
      expect((await read(await post())).status).toBe(500);
      expect(inspect([mockLogAudit.mock.calls, (console.error as jest.Mock).mock.calls], { depth: null })).not.toContain('PRIVATE-MARKER');
    });
  });

  test('FREQ-530-AC-01: route file は POST だけを export する', () => {
    expect(Object.keys(attachmentsRoute).sort()).toEqual(['POST']);
  });
});

// ---- POST .../attachments/[attachmentId]/revisions ----

describe('POST /api/admin/purchase-orders/[id]/attachments/[attachmentId]/revisions（訂正・無効化）', () => {
  const body = {
    transactionDate: '2026-10-27', amountYen: 7000, currency: 'JPY', counterparty: '工場B', voided: false, reason: '宛先の誤り', requestKey: REQUEST_KEY,
  };
  const dbResult = { attachmentId: ATTACHMENT_ID, revisionNo: 2, replayed: false };
  const post = (payload: unknown = body, ids: Record<string, string> = {}) => revisionsRoute.POST(
    jsonRequest(`${base(ids.id)}/${ids.attachmentId ?? ATTACHMENT_ID}/revisions`, payload),
    { params: Promise.resolve({ id: ids.id ?? ORDER_ID, attachmentId: ids.attachmentId ?? ATTACHMENT_ID }) },
  );
  const arrange = () => rpc.mockResolvedValue({ data: dbResult, error: null });

  commonWriteTests('訂正', 'admin.purchase_orders.attachment.revise', 30, post, body, arrange);

  describe('成功・検証・失敗', () => {
    beforeEach(arrange);

    test('FREQ-530-AC-02: 201 で { attachmentId, revisionNo, replayed } を返し no-store。理由は前後の空白を落とす。置き場には触れない', async () => {
      const result = await read(await post({ ...body, reason: '  宛先の誤り  ', actorId: 'forged' }));
      expect(result.status).toBe(201);
      expect(result.response.headers.get('cache-control')).toBe('no-store');
      expect(result.json).toEqual(dbResult);
      expect(rpc).toHaveBeenCalledWith('admin_revise_purchase_order_document', {
        _attachment_id: ATTACHMENT_ID, _purchase_order_id: ORDER_ID, _transaction_date: '2026-10-27', _amount_yen: 7000, _currency: 'JPY',
        _counterparty: '工場B', _voided: false, _reason: '宛先の誤り', _actor_id: 'authorized-actor', _request_key: REQUEST_KEY,
      });
      expect(bucket.download).not.toHaveBeenCalled();
      expect(bucket.createSignedUploadUrl).not.toHaveBeenCalled();
    });

    test('FREQ-530-AC-02: 無効化（voided: true）も同じ入口。監査 admin.purchase_orders.attachment.revise は発注書・添付の id・無効化かどうか・再送かどうかだけ（理由・要求番号は残さない）', async () => {
      await post({ ...body, voided: true });
      expect(rpc).toHaveBeenCalledWith('admin_revise_purchase_order_document', expect.objectContaining({ _voided: true }));
      expect(mockLogAudit).toHaveBeenCalledWith({
        action: 'admin.purchase_orders.attachment.revise', actor_id: 'authorized-actor', resource: 'purchase_orders', resource_id: ORDER_ID,
        outcome: 'success', metadata: { attachment_id: ATTACHMENT_ID, voided: true, replayed: false },
      });
      const logged = JSON.stringify(mockLogAudit.mock.calls);
      for (const value of ['宛先の誤り', '工場B', REQUEST_KEY]) expect(logged).not.toContain(value);
    });

    test('FREQ-530-AC-02: 同じ要求の再送（replayed: true）も201', async () => {
      rpc.mockResolvedValue({ data: { ...dbResult, replayed: true }, error: null });
      const result = await read(await post());
      expect(result.status).toBe(201);
      expect(result.json.replayed).toBe(true);
    });

    test.each([
      ['取引日が実在しない', { ...body, transactionDate: '2026-13-01' }],
      ['取引日が 2000-01-01 より前', { ...body, transactionDate: '1999-12-31' }],
      ['金額が負', { ...body, amountYen: -5 }],
      ['金額が上限超え', { ...body, amountYen: 100000000000 }],
      ['通貨が JPY でない', { ...body, currency: 'EUR' }],
      ['取引先が空', { ...body, counterparty: '' }],
      ['voided が真偽でない', { ...body, voided: 'yes' }],
      ['voided が無い', { ...body, voided: undefined }],
      ['理由が無い', { ...body, reason: undefined }],
      ['理由が空白だけ', { ...body, reason: '   ' }],
      ['理由が201字', { ...body, reason: 'あ'.repeat(201) }],
      ['requestKey が uuid でない', { ...body, requestKey: 'x' }],
      ['本文が JSON でない', 'not json'],
    ])('FREQ-530-AC-02: 検証 %s は 400 で、DB に進まない。監査は failure と結果コードだけ', async (_name, payload) => {
      const { status, json } = await read(await post(payload));
      expect(status).toBe(400);
      expect(json.error).toBe('Invalid request');
      expect(rpc).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', resource_id: ORDER_ID, metadata: { code: 'INVALID_REQUEST' } }));
    });

    test('FREQ-530-AC-02: 理由ちょうど200字・金額0は通る', async () => {
      expect((await post({ ...body, reason: 'う'.repeat(200), amountYen: 0 })).status).toBe(201);
    });

    test('FREQ-530-AC-02: 添付の id が uuid でなければ 400。監査の resource_id は発注書の id', async () => {
      const { status } = await read(await post(body, { attachmentId: 'nope' }));
      expect(status).toBe(400);
      expect(rpc).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', resource_id: ORDER_ID, metadata: { code: 'INVALID_REQUEST' } }));
    });

    test.each([
      ['GROUP_G_ARGUMENT_INVALID', '22023', 400, '入力を確かめてください。'],
      ['GROUP_G_PO_REASON_REQUIRED', '22023', 400, '理由を入力してください。'],
      ['GROUP_G_FORBIDDEN', '42501', 403, '発注を扱う権限がありません。'],
      ['GROUP_G_PO_NOT_FOUND', 'P0002', 404, '発注書が見つかりません。'],
      ['GROUP_G_REQUEST_KEY_CONFLICT', '23505', 409, '同じ要求番号で異なる操作は実行できません。'],
    ])('FREQ-530-AC-02: DB の %s（%s）は %i と本文を { code, error } で返す。監査は failure と voided と結果コードだけ', async (message, sqlstate, status, text) => {
      rpc.mockResolvedValue({ data: null, error: { message, code: sqlstate, details: 'PRIVATE-MARKER' } });
      const result = await read(await post());
      expect(result.status).toBe(status);
      expect(result.json).toEqual({ code: message, error: text });
      expect(result.text).not.toContain('PRIVATE-MARKER');
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', metadata: { attachment_id: ATTACHMENT_ID, voided: false, code: message } }));
    });

    test('FREQ-530-AC-02: 未知の DB エラー・戻り値の崩れは固定の500', async () => {
      rpc.mockResolvedValue({ data: null, error: { message: 'PRIVATE-MARKER', code: '23514' } });
      const unknown = await read(await post());
      expect(unknown.status).toBe(500);
      expect(unknown.json).toEqual({ error: '発注の記録に失敗しました' });
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'error', metadata: { attachment_id: ATTACHMENT_ID, voided: false, code: 'PURCHASE_ORDER_ATTACHMENT_REVISE_FAILED' },
      }));
      rpc.mockResolvedValue({ data: { attachmentId: ATTACHMENT_ID, revisionNo: 0, replayed: false }, error: null });
      expect((await read(await post())).status).toBe(500);
    });
  });

  test('FREQ-530-AC-01: route file は POST だけを export する（上書きの PATCH・DELETE・PUT は無い）', () => {
    expect(Object.keys(revisionsRoute).sort()).toEqual(['POST']);
  });
});

// ---- GET .../attachments/[attachmentId]/url ----

describe('GET /api/admin/purchase-orders/[id]/attachments/[attachmentId]/url（60秒の署名つきリンク）', () => {
  const get = (query = '', ids: Record<string, string> = {}) => {
    const request = new Request(`${base(ids.id)}/${ids.attachmentId ?? ATTACHMENT_ID}/url${query}`);
    return urlRoute.GET(request, { params: Promise.resolve({ id: ids.id ?? ORDER_ID, attachmentId: ids.attachmentId ?? ATTACHMENT_ID }) });
  };
  const arrange = () => {
    mockRpcWithOrder();
    tables[ATTACHMENTS] = queryOf([{ storage_path: STORAGE_PATH, original_file_name: 'invoice.pdf' }]);
    bucket.createSignedUrl.mockResolvedValue({ data: { signedUrl: SIGNED_VIEW }, error: null });
  };
  beforeEach(arrange);

  test('FREQ-530-AC-03: 200 で { url, expiresInSeconds: 60 } を no-store で返す。表示用は原ファイル名の指定なし', async () => {
    const result = await read(await get());
    expect(result.status).toBe(200);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.json).toEqual({ url: SIGNED_VIEW, expiresInSeconds: 60 });
    expect(bucket.createSignedUrl.mock.calls[0]).toEqual([STORAGE_PATH, 60]);
  });

  test('FREQ-530-AC-03: download=1 は原ファイル名つきのダウンロード用リンク', async () => {
    await get('?download=1');
    expect(bucket.createSignedUrl.mock.calls[0]).toEqual([STORAGE_PATH, 60, { download: 'invoice.pdf' }]);
  });

  test('FREQ-540-AC-07: 権限は admin.purchase_orders.read だけ（manage は要らない）。足りなければ 403 で no-store、制限・DB・置き場には進まない', async () => {
    mockAcl(['admin.purchase_orders.read']);
    expect((await get()).status).toBe(200);
    expect(authorizeOne).toHaveBeenCalledWith('admin.purchase_orders.read', expect.anything());
    mockRateLimit.mockClear();
    rpc.mockClear();
    for (const held of [[], ['admin.purchase_orders.manage'], ['admin.items.read', 'admin.stock.read']]) {
      mockAcl(held);
      const denied = await read(await get());
      expect(denied.status).toBe(403);
      expect(denied.response.headers.get('cache-control')).toBe('no-store');
      expect(denied.json).toEqual({ error: 'Forbidden', permission: 'admin.purchase_orders.read', role: 'supporter' });
    }
    expect(mockRateLimit).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(bucket.createSignedUrl).toHaveBeenCalledTimes(1);
  });

  test.each([
    [401, { error: 'Unauthorized' }], [403, { error: 'Forbidden', reason: 'MFA required' }], [503, { error: 'Service temporarily unavailable' }],
  ])('FREQ-540-AC-07: 認可の拒否 %s は状態と本文をそのまま返し no-store', async (status, payload) => {
    authorizeOne.mockResolvedValue({ ok: false, response: new Response(JSON.stringify(payload), { status }) });
    const result = await read(await get());
    expect(result.status).toBe(status);
    expect(result.json).toEqual(payload);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(rpc).not.toHaveBeenCalled();
  });

  test('FREQ-530-AC-03: 認可 → IP の回数制限 → actor の回数制限 → 読取の確かめ（DB）→ 添付の表 → 署名つきリンク の順', async () => {
    const order: string[] = [];
    authorizeOne.mockImplementation(async () => { order.push('authorize'); return { ok: true, userId: 'authorized-actor', role: 'admin' }; });
    mockRateLimit.mockImplementation(async (arg: { subject?: string }) => { order.push(arg.subject ? 'rate:actor' : 'rate:ip'); return null; });
    rpc.mockImplementation(async () => { order.push('rpc'); return { data: confirmedDetail(), error: null }; });
    from.mockImplementation((table: string) => { order.push(table); return queryOf([{ storage_path: STORAGE_PATH, original_file_name: 'invoice.pdf' }]); });
    bucket.createSignedUrl.mockImplementation(async () => { order.push('sign'); return { data: { signedUrl: SIGNED_VIEW }, error: null }; });
    expect((await get()).status).toBe(200);
    expect(order).toEqual(['authorize', 'rate:ip', 'rate:actor', 'rpc', ATTACHMENTS, 'sign']);
    expect(mockCsrf).not.toHaveBeenCalled();
  });

  test('FREQ-530-AC-03: 回数制限は admin.purchase_orders.attachment.view の 120 回/600 秒を IP と actor の2回。超えた Response はそのまま返し、DB に進まない', async () => {
    await get();
    expect(mockRateLimit).toHaveBeenCalledTimes(2);
    expect(mockRateLimit).toHaveBeenNthCalledWith(1, expect.objectContaining({ endpoint: 'admin.purchase_orders.attachment.view', limit: 120, windowSeconds: 600 }));
    expect(mockRateLimit.mock.calls[0][0]).not.toHaveProperty('subject');
    expect(mockRateLimit).toHaveBeenNthCalledWith(2, expect.objectContaining({ endpoint: 'admin.purchase_orders.attachment.view', limit: 120, windowSeconds: 600, subject: 'authorized-actor' }));
    rpc.mockClear();
    for (const stage of [1, 2]) {
      const limited = new Response('Limited', { status: 429 });
      if (stage === 2) mockRateLimit.mockResolvedValueOnce(null);
      mockRateLimit.mockResolvedValueOnce(limited);
      expect(await get()).toBe(limited);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  test.each([
    ['発注書の id が uuid でない', '', { id: 'abc' }],
    ['添付の id が uuid でない', '', { attachmentId: '../x' }],
    ['download が 1 以外', '?download=true', {}],
    ['download が空', '?download=', {}],
  ])('FREQ-530-AC-03: %s は 400 で no-store。DB にも置き場にも進まない', async (_name, query, ids) => {
    const result = await read(await get(query, ids));
    expect(result.status).toBe(400);
    expect(result.json).toEqual({ error: 'Invalid request' });
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(rpc).not.toHaveBeenCalled();
    expect(bucket.createSignedUrl).not.toHaveBeenCalled();
  });

  test('FREQ-540-AC-07: DB が 42501 で断れば 403 { code, error }、発注書が無ければ 404。添付の表にも置き場にも進まない', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'GROUP_G_FORBIDDEN', code: '42501' } });
    const forbidden = await read(await get());
    expect(forbidden.status).toBe(403);
    expect(forbidden.json).toEqual({ code: 'GROUP_G_FORBIDDEN', error: '発注を扱う権限がありません。' });
    rpc.mockResolvedValueOnce({ data: null, error: null });
    const missing = await read(await get());
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual({ code: 'GROUP_G_PO_NOT_FOUND', error: '発注書が見つかりません。' });
    expect(rpc).toHaveBeenNthCalledWith(1, 'get_admin_purchase_order', { _purchase_order_id: ORDER_ID, _actor_id: 'authorized-actor' });
    expect(from).not.toHaveBeenCalled();
    expect(bucket.createSignedUrl).not.toHaveBeenCalled();
  });

  test.each([
    ['添付が無い', () => { tables[ATTACHMENTS] = queryOf([]); }, 404, { code: 'DOCUMENT_NOT_FOUND', error: '原本を取得できません。' }],
    ['置き場に無い', () => bucket.createSignedUrl.mockResolvedValue({ data: null, error: { status: 400, statusCode: '404' } }), 404, { code: 'DOCUMENT_NOT_FOUND', error: '原本を取得できません。' }],
    ['置き場の不調', () => bucket.createSignedUrl.mockResolvedValue({ data: null, error: { status: 502, message: STORAGE_PATH } }), 503,
      { code: 'DOCUMENT_STORAGE_UNAVAILABLE', error: 'ファイルの保存先に接続できません。時間をおいて再度お試しください。' }],
  ])('FREQ-530-AC-03: %s は %i の { code, error }。応答・ログに保存キーが無い', async (_name, setup, status, payload) => {
    setup();
    const result = await read(await get());
    expect(result.status).toBe(status);
    expect(result.json).toEqual(payload);
    noSecret([result.text, (console.error as jest.Mock).mock.calls]);
  });

  test('FREQ-530-AC-03: 未知の失敗は固定の500 { error: 原本を取得できません。 } で、生の文を出さない', async () => {
    tables[ATTACHMENTS] = queryOf(null, { message: 'PRIVATE-MARKER' });
    const result = await read(await get());
    expect(result.status).toBe(500);
    expect(result.json).toEqual({ error: '原本を取得できません。' });
    expect(inspect([result.text, (console.error as jest.Mock).mock.calls], { depth: null })).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-530-AC-03: 署名つきリンクは応答にだけ載せ、監査にもログにも出さない（読むだけなので監査は呼ばない）', async () => {
    const result = await read(await get('?download=1'));
    expect(result.json.url).toBe(SIGNED_VIEW);
    expect(mockLogAudit).not.toHaveBeenCalled();
    noSecret([mockLogAudit.mock.calls, (console.error as jest.Mock).mock.calls, (console.log as jest.Mock).mock.calls].map((calls) => calls.map(String)));
  });

  test('FREQ-530-AC-01: route file は GET だけを export する', () => {
    expect(Object.keys(urlRoute).sort()).toEqual(['GET']);
  });
});
