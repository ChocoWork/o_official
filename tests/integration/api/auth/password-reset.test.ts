/**
 * Password Reset API Integration Tests
 * タスク: [AUTH-01-09]
 * 対応 REQ: REQ-AUTH-004
 * 対応 ARCH-ID: ARCH-AUTH-04
 * 仕様書: docs/specs/01_auth.md §4.4
 */

// Mock rate limit middleware
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

// Mock Turnstile verification
jest.mock('@/lib/turnstile', () => ({
  verifyTurnstile: jest.fn().mockResolvedValue({ ok: true }),
}));

// Mock mail service
jest.mock('@/lib/mail', () => jest.fn().mockResolvedValue(undefined));

// Mock audit log
jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

// Mock hash utilities
jest.mock('@/lib/hash', () => ({
  tokenHashSha256: jest.fn((token: string) => `hashed_${token}`),
}));

// Mock Supabase client with dynamic configuration
let mockFromImplementation: any;
let mockUpdateUserByIdImplementation: any;

jest.mock('@/lib/supabase/server', () => {
  return {
    createServiceRoleClient: jest.fn(() => ({
      from: jest.fn((table: string) => {
        if (mockFromImplementation) {
          return mockFromImplementation(table);
        }
        // Default mock behavior
        if (table === 'users') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'user-123' }, error: null }),
          };
        }
        if (table === 'password_reset_tokens') {
          const eqMock = jest.fn().mockResolvedValue({ data: null, error: null });
          return {
            insert: jest.fn().mockResolvedValue({ data: [{ id: 'token-id' }], error: null }),
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            gte: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: { id: 'token-123', user_id: 'user-123', email: 'test@example.com', used: false },
              error: null,
            }),
            update: jest.fn().mockReturnValue({ eq: eqMock }),
          };
        }
        return {
          insert: jest.fn().mockResolvedValue({ data: [], error: null }),
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
        };
      }),
      auth: {
        admin: {
          updateUserById: jest.fn((...args: any[]) => {
            if (mockUpdateUserByIdImplementation) {
              return mockUpdateUserByIdImplementation(...args);
            }
            return Promise.resolve({ data: { user: { id: 'user-123' } }, error: null });
          }),
        },
      },
    })),
  };
});

// Mock NextResponse
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: any, init?: any) => ({
      status: init?.status ?? 200,
      _body: body,
      json: async () => body,
    }),
  },
}));

const { logAudit } = require('@/lib/audit');
const sendMail = require('@/lib/mail');
let requestHandler: any;
let confirmHandler: any;

describe('Password Reset API - Integration Tests', () => {
  beforeAll(async () => {
    requestHandler = (await import('@/app/api/auth/password-reset/request/route')).POST;
    confirmHandler = (await import('@/app/api/auth/password-reset/confirm/route')).POST;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockFromImplementation = null;
    mockUpdateUserByIdImplementation = null;
    process.env.NEXT_PUBLIC_BASE_URL = 'http://localhost:3000';
  });

  describe('POST /api/auth/password-reset/request', () => {
    describe('正常系', () => {
      test('[SUCCESS] メール送信リクエストで 200 OK', async () => {
        const req = new Request('http://localhost/api/auth/password-reset/request', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: 'test@example.com',
            turnstileToken: 'valid-token',
          }),
        });

        const res: any = await requestHandler(req);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.ok).toBe(true);

        // メール送信が実行されたことを確認
        expect(sendMail).toHaveBeenCalledWith(
          expect.objectContaining({
            to: 'test@example.com',
            subject: 'Password reset',
          })
        );

        // 監査ログが記録されていることを確認
        expect(logAudit).toHaveBeenCalledWith({
          action: 'password_reset_request',
          actor_email: 'test@example.com',
          outcome: 'success',
          resource_id: 'user-123',
        });
      });

      test('[SUCCESS] 存在しないメールでも 200 OK（列挙攻撃対策）', async () => {
        // users テーブルでユーザーが見つからない場合
        mockFromImplementation = (table: string) => {
          if (table === 'users') {
            return {
              select: jest.fn().mockReturnThis(),
              eq: jest.fn().mockReturnThis(),
              maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
            };
          }
          if (table === 'password_reset_tokens') {
            return {
              insert: jest.fn().mockResolvedValue({ data: [], error: null }),
            };
          }
          return {};
        };

        const req = new Request('http://localhost/api/auth/password-reset/request', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: 'nonexistent@example.com',
            turnstileToken: 'valid-token',
          }),
        });

        const res: any = await requestHandler(req);
        const body = await res.json();

        // 存在しないメールでも 200 を返すことで列挙攻撃を防ぐ
        expect(res.status).toBe(200);
        expect(body.ok).toBe(true);
      });

      test('[SUCCESS] トークンがハッシュ化されて保存される', async () => {
        const insertMock = jest.fn().mockResolvedValue({ data: [{ id: 'token-id' }], error: null });
        
        mockFromImplementation = (table: string) => {
          if (table === 'password_reset_tokens') {
            return { insert: insertMock };
          }
          if (table === 'users') {
            return {
              select: jest.fn().mockReturnThis(),
              eq: jest.fn().mockReturnThis(),
              maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'user-123' }, error: null }),
            };
          }
          return {};
        };

        const req = new Request('http://localhost/api/auth/password-reset/request', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: 'test@example.com',
            turnstileToken: 'valid-token',
          }),
        });

        await requestHandler(req);

        // トークンがハッシュ化されて保存されることを確認
        expect(insertMock).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              email: 'test@example.com',
              used: false,
              token_hash: expect.stringContaining('hashed_'),
              expires_at: expect.any(String),
            }),
          ])
        );
      });
    });

    describe('異常系', () => {
      test('[ERROR] Turnstile 検証失敗で 403 Forbidden', async () => {
        const { verifyTurnstile } = require('@/lib/turnstile');
        verifyTurnstile.mockResolvedValue({ ok: false, error: 'Invalid token' });

        const req = new Request('http://localhost/api/auth/password-reset/request', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: 'test@example.com',
            turnstileToken: 'invalid-token',
          }),
        });

        const res: any = await requestHandler(req);

        expect(res.status).toBe(403);
        expect(sendMail).not.toHaveBeenCalled();
      });

      test('[VALIDATION] 不正なメールフォーマットで 400 Bad Request', async () => {
        const req = new Request('http://localhost/api/auth/password-reset/request', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: 'invalid-email',
            turnstileToken: 'valid-token',
          }),
        });

        const res: any = await requestHandler(req);

        expect(res.status).toBe(400);
      });
    });

    describe('セキュリティ', () => {
      test('[SECURITY] レート制限チェックが実行されている', async () => {
        const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');

        const req = new Request('http://localhost/api/auth/password-reset/request', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: 'test@example.com',
            turnstileToken: 'valid-token',
          }),
        });

        await requestHandler(req);

        // IP およびアカウントレベルのレート制限が確認されていることを確認
        expect(enforceRateLimit).toHaveBeenCalled();
      });
    });
  });

  describe('POST /api/auth/password-reset/confirm', () => {
    describe('正常系', () => {
      test('[SUCCESS] 有効なトークンでパスワード更新 200 OK', async () => {
        const updateUserByIdMock = jest.fn().mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null });
        mockUpdateUserByIdImplementation = updateUserByIdMock;

        const req = new Request('http://localhost/api/auth/password-reset/confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: 'valid-token-hex',
            email: 'test@example.com',
            new_password: 'NewPassword123!',
          }),
        });

        const res: any = await confirmHandler(req);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.ok).toBe(true);

        // パスワード更新が実行されたことを確認
        expect(updateUserByIdMock).toHaveBeenCalledWith(
          'user-123',
          { password: 'NewPassword123!' }
        );

        // トークンの使用済みフラグが立てられることを確認（モック内で確認）
        expect(logAudit).toHaveBeenCalledWith({
          action: 'password_reset_confirm',
          actor_email: 'test@example.com',
          outcome: 'success',
          resource_id: 'user-123',
        });
      });

      test('[SUCCESS] トークンが使用済みにマークされる', async () => {
        const eqMock = jest.fn().mockResolvedValue({ data: null, error: null });
        const updateMock = jest.fn().mockReturnValue({ eq: eqMock });
        
        mockFromImplementation = (table: string) => {
          if (table === 'password_reset_tokens') {
            return {
              select: jest.fn().mockReturnThis(),
              eq: jest.fn().mockReturnThis(),
              gte: jest.fn().mockReturnThis(),
              maybeSingle: jest.fn().mockResolvedValue({
                data: { id: 'token-123', user_id: 'user-123', email: 'test@example.com', used: false },
                error: null,
              }),
              update: updateMock,
            };
          }
          if (table === 'users') {
            return {
              select: jest.fn().mockReturnThis(),
              eq: jest.fn().mockReturnThis(),
              maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'user-123' }, error: null }),
            };
          }
          return {};
        };

        const req = new Request('http://localhost/api/auth/password-reset/confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: 'valid-token',
            email: 'test@example.com',
            new_password: 'NewPassword123!',
          }),
        });

        await confirmHandler(req);

        // トークンが使用済みに更新されることを確認
        expect(updateMock).toHaveBeenCalledWith({ used: true });
        expect(eqMock).toHaveBeenCalledWith('id', 'token-123');
      });
    });

    describe('異常系', () => {
      test('[ERROR] 無効なトークンで 400 Bad Request', async () => {
        mockFromImplementation = (table: string) => {
          if (table === 'password_reset_tokens') {
            return {
              select: jest.fn().mockReturnThis(),
              eq: jest.fn().mockReturnThis(),
              gte: jest.fn().mockReturnThis(),
              maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
            };
          }
          if (table === 'users') {
            return {
              select: jest.fn().mockReturnThis(),
              eq: jest.fn().mockReturnThis(),
              maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'user-123' }, error: null }),
            };
          }
          return {};
        };

        const req = new Request('http://localhost/api/auth/password-reset/confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: 'invalid-token',
            email: 'test@example.com',
            new_password: 'NewPassword123!',
          }),
        });

        const res: any = await confirmHandler(req);

        expect(res.status).toBe(400);
        expect(logAudit).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'password_reset_confirm',
            outcome: 'failure',
          })
        );
      });

      test('[ERROR] 期限切れトークンで 400 Bad Request', async () => {
        mockFromImplementation = (table: string) => {
          if (table === 'password_reset_tokens') {
            return {
              select: jest.fn().mockReturnThis(),
              eq: jest.fn().mockReturnThis(),
              gte: jest.fn().mockReturnThis(),
              maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
            };
          }
          if (table === 'users') {
            return {
              select: jest.fn().mockReturnThis(),
              eq: jest.fn().mockReturnThis(),
              maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'user-123' }, error: null }),
            };
          }
          return {};
        };

        const req = new Request('http://localhost/api/auth/password-reset/confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: 'expired-token',
            email: 'test@example.com',
            new_password: 'NewPassword123!',
          }),
        });

        const res: any = await confirmHandler(req);

        expect(res.status).toBe(400);
      });

      test('[VALIDATION] パスワードが短すぎる場合 400 Bad Request', async () => {
        const req = new Request('http://localhost/api/auth/password-reset/confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: 'valid-token',
            email: 'test@example.com',
            new_password: 'short',
          }),
        });

        const res: any = await confirmHandler(req);

        expect(res.status).toBe(400);
      });

      test('[ERROR] ユーザーが存在しない場合 404 Not Found', async () => {
        mockFromImplementation = (table: string) => {
          if (table === 'password_reset_tokens') {
            return {
              select: jest.fn().mockReturnThis(),
              eq: jest.fn().mockReturnThis(),
              gte: jest.fn().mockReturnThis(),
              maybeSingle: jest.fn().mockResolvedValue({
                data: { id: 'token-123', user_id: null, email: 'test@example.com', used: false },
                error: null,
              }),
            };
          }
          if (table === 'users') {
            return {
              select: jest.fn().mockReturnThis(),
              eq: jest.fn().mockReturnThis(),
              maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
            };
          }
          return {};
        };

        const req = new Request('http://localhost/api/auth/password-reset/confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: 'valid-token',
            email: 'test@example.com',
            new_password: 'NewPassword123!',
          }),
        });

        const res: any = await confirmHandler(req);

        expect(res.status).toBe(404);
      });
    });
  });
});

export {};
