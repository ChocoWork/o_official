export {};

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      _body: body,
      json: async () => body,
    }),
  },
}));

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn(),
}));

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: jest.fn(),
}));

import { POST } from '@/app/api/admin/create-user/route';

const { createServiceRoleClient } = require('@/lib/supabase/server');
const { logAudit } = require('@/lib/audit');
const { authorizeAdminPermission } = require('@/lib/auth/admin-rbac');

const createUser = jest.fn();

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/admin/create-user', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const validBody = { email: 'new@example.com', password: 'password-1234', display_name: '新人' };

function allowAdmin() {
  authorizeAdminPermission.mockResolvedValue({
    ok: true,
    userId: 'admin-1',
    role: 'admin',
    actorEmail: 'admin@example.com',
  });
}

describe('POST /api/admin/create-user', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    authorizeAdminPermission.mockReset();
    createUser.mockReset();
    createServiceRoleClient.mockResolvedValue({ auth: { admin: { createUser } } });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    allowAdmin();
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('DD-ADMIN-002 認可が ok:false の時は認可の応答を返し、Auth の機能も監査も呼ばない', async () => {
    const response = { status: 403, json: async () => ({ error: 'Forbidden' }) };
    authorizeAdminPermission.mockResolvedValue({ ok: false, response });

    const res = await POST(makeRequest(validBody));

    expect(res).toBe(response);
    expect(authorizeAdminPermission).toHaveBeenCalledWith('admin.users.manage', expect.any(Request));
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-002 本文が JSON でない時は 500 Internal server error で、監査を書かない', async () => {
    const res = await POST(makeRequest('{not json'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(logAudit).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-002 メールの形でない時は 400 で、監査に failure を書く', async () => {
    const res = await POST(makeRequest({ ...validBody, email: 'not-an-email' }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid request' });
    expect(logAudit).toHaveBeenCalledWith({
      action: 'admin_create_user',
      actor_id: 'admin-1',
      actor_email: 'admin@example.com',
      resource: 'users',
      outcome: 'failure',
      detail: 'Invalid request body',
    });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-002 パスワードが7文字の時は 400 で、監査に failure を書く', async () => {
    const res = await POST(makeRequest({ ...validBody, password: '1234567' }));

    expect(res.status).toBe(400);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));
    expect(createUser).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-002 パスワードが8文字なら通る', async () => {
    createUser.mockResolvedValue({ data: { user: { id: 'u-8', email: 'new@example.com' } }, error: null });

    const res = await POST(makeRequest({ ...validBody, password: '12345678' }));

    expect(res.status).toBe(201);
  });

  it('DD-ADMIN-002 作成が成功した時は 201 id とメールを返し、監査に success と id を書く', async () => {
    createUser.mockResolvedValue({ data: { user: { id: 'u-1', email: 'new@example.com' } }, error: null });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'u-1', email: 'new@example.com' });
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'admin_create_user',
      actor_id: 'admin-1',
      actor_email: 'admin@example.com',
      resource: 'users',
      resource_id: 'u-1',
      outcome: 'success',
    });
  });

  it('DD-ADMIN-002 作成の結果に利用者が無い時も 201 で、id とメールが空になる', async () => {
    createUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: undefined, email: undefined });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', resource_id: undefined }));
  });

  it('DD-ADMIN-002 表示名を渡すと user_metadata.display_name に入り、確認済みの印と役割は渡さない', async () => {
    createUser.mockResolvedValue({ data: { user: { id: 'u-1', email: 'new@example.com' } }, error: null });

    await POST(makeRequest(validBody));

    expect(createUser).toHaveBeenCalledWith({
      email: 'new@example.com',
      password: 'password-1234',
      user_metadata: { display_name: '新人' },
    });
  });

  it('DD-ADMIN-002 表示名を省くと user_metadata.display_name は空のまま渡す', async () => {
    createUser.mockResolvedValue({ data: { user: { id: 'u-1', email: 'new@example.com' } }, error: null });

    await POST(makeRequest({ email: 'new@example.com', password: 'password-1234' }));

    expect(createUser).toHaveBeenCalledWith({
      email: 'new@example.com',
      password: 'password-1234',
      user_metadata: { display_name: undefined },
    });
  });

  it('DD-ADMIN-002 誤りの文が User already registered の時は 409 で、監査に conflict を書く', async () => {
    createUser.mockResolvedValue({ data: { user: null }, error: { message: 'User already registered' } });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Email already registered' });
    expect(logAudit).toHaveBeenCalledWith({
      action: 'admin_create_user',
      actor_id: 'admin-1',
      actor_email: 'admin@example.com',
      resource: 'users',
      outcome: 'conflict',
      detail: 'User already registered',
    });
  });

  it('DD-ADMIN-002 誤りの文が duplicate key の時は 409 で、大文字小文字を問わず監査に conflict を書く', async () => {
    createUser.mockResolvedValue({ data: { user: null }, error: { message: 'Duplicate key value' } });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(409);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'conflict', detail: 'Duplicate key value' }),
    );
  });

  it('DD-ADMIN-002 誤りの文がほかの時は 500 Failed to create user で、監査に error を書く', async () => {
    createUser.mockResolvedValue({ data: { user: null }, error: { message: 'database unavailable' } });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to create user' });
    expect(logAudit).toHaveBeenCalledWith({
      action: 'admin_create_user',
      actor_id: 'admin-1',
      actor_email: 'admin@example.com',
      resource: 'users',
      outcome: 'error',
      detail: 'database unavailable',
    });
  });

  it('DD-ADMIN-002 誤りの文が空の時も 500 Failed to create user で、監査に error を書く', async () => {
    createUser.mockResolvedValue({ data: { user: null }, error: { message: '' } });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to create user' });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', detail: '' }));
  });

  it('DD-ADMIN-002 誤りに文が無い時も 500 Failed to create user で、監査に error を書く', async () => {
    createUser.mockResolvedValue({ data: { user: null }, error: {} });

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(500);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error' }));
  });

  it('DD-ADMIN-002 createServiceRoleClient が例外を投げた時は 500 Internal server error', async () => {
    createServiceRoleClient.mockRejectedValue(new Error('no service role'));

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('DD-ADMIN-002 認可の部品が例外を投げた時は 500 Internal server error', async () => {
    authorizeAdminPermission.mockRejectedValue(new Error('rbac down'));

    const res = await POST(makeRequest(validBody));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(createUser).not.toHaveBeenCalled();
  });
});
