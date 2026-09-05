describe('login 2FA session', () => {
  const originalSecret = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-jwt-secret';
  });

  afterAll(() => {
    process.env.JWT_SECRET = originalSecret;
  });

  test('[SECURITY] TTL は 300 秒（Supabase の Email OTP Expiration に合わせる）', async () => {
    const { loginTwoFactorSessionMaxAgeSeconds } = await import(
      '@/features/auth/services/login-2fa-session'
    );

    // Cookie だけが長いと、コードが切れているのに入力画面が生きている窓ができる。
    expect(loginTwoFactorSessionMaxAgeSeconds).toBe(300);
  });

  test('発行したトークンの exp が TTL と一致する', async () => {
    const {
      createLoginTwoFactorSessionToken,
      verifyLoginTwoFactorSessionToken,
      loginTwoFactorSessionMaxAgeSeconds,
    } = await import('@/features/auth/services/login-2fa-session');

    const before = Math.floor(Date.now() / 1000);
    const token = createLoginTwoFactorSessionToken({
      userId: 'user-123',
      email: 'test@example.com',
    });

    const session = verifyLoginTwoFactorSessionToken(token);
    expect(session).not.toBeNull();
    expect(session!.email).toBe('test@example.com');
    expect(session!.userId).toBe('user-123');
    expect(session!.exp - before).toBeGreaterThanOrEqual(
      loginTwoFactorSessionMaxAgeSeconds - 2,
    );
    expect(session!.exp - before).toBeLessThanOrEqual(
      loginTwoFactorSessionMaxAgeSeconds + 2,
    );
  });

  test('[SECURITY] 発行から 30 分を超えたトークンは exp が未来でも無効', async () => {
    // OWASP ASVS V3.3.2: セッションには絶対タイムアウトが要る。
    // exp（5 分・スライド）だけだと、再送を続ける限り保留状態を延ばせる。
    const {
      createLoginTwoFactorSessionToken,
      verifyLoginTwoFactorSessionToken,
    } = await import('@/features/auth/services/login-2fa-session');

    const now = Math.floor(Date.now() / 1000);
    const token = createLoginTwoFactorSessionToken({
      userId: 'user-123',
      email: 'test@example.com',
      issuedAt: now - 31 * 60,
    });

    // exp は未来（発行時に now + 300 で作られる）
    expect(verifyLoginTwoFactorSessionToken(token)).toBeNull();
  });

  test('[SECURITY] 再送での再発行は元の iat を引き継ぐ', async () => {
    const {
      createLoginTwoFactorSessionToken,
      verifyLoginTwoFactorSessionToken,
    } = await import('@/features/auth/services/login-2fa-session');

    const first = verifyLoginTwoFactorSessionToken(
      createLoginTwoFactorSessionToken({
        userId: 'user-123',
        email: 'test@example.com',
      }),
    );
    expect(first).not.toBeNull();

    // 再送は元の iat を渡して再発行する。渡さないと窓がリセットされ上限が意味を失う。
    const reissued = verifyLoginTwoFactorSessionToken(
      createLoginTwoFactorSessionToken({
        userId: first!.userId,
        email: first!.email,
        issuedAt: first!.iat,
      }),
    );

    expect(reissued).not.toBeNull();
    expect(reissued!.iat).toBe(first!.iat);
    expect(reissued!.exp).toBeGreaterThanOrEqual(first!.exp);
  });

  test('iat を持たない古いトークンは無効（互換性は切る）', async () => {
    // 影響を受けるのは「デプロイ時点でパスワード送信済み・OTP 未入力」の人だけ。
    // TTL が 5 分なので窓は最大 5 分、やり直しで完全復帰できる。
    const crypto = await import('crypto');
    process.env.JWT_SECRET = 'test-jwt-secret';
    const payload = Buffer.from(
      JSON.stringify({
        purpose: 'login_2fa',
        userId: 'user-123',
        email: 'test@example.com',
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
      'utf8',
    ).toString('base64url');
    const signature = crypto
      .createHmac('sha256', 'test-jwt-secret')
      .update(payload)
      .digest('base64url');

    const { verifyLoginTwoFactorSessionToken } = await import(
      '@/features/auth/services/login-2fa-session'
    );
    expect(
      verifyLoginTwoFactorSessionToken(`${payload}.${signature}`),
    ).toBeNull();
  });

  test('改竄されたトークンは通らない', async () => {
    const { createLoginTwoFactorSessionToken, verifyLoginTwoFactorSessionToken } =
      await import('@/features/auth/services/login-2fa-session');

    const token = createLoginTwoFactorSessionToken({
      userId: 'user-123',
      email: 'test@example.com',
    });
    const [payload, signature] = token.split('.');
    const forged = `${payload}x.${signature}`;

    expect(verifyLoginTwoFactorSessionToken(forged)).toBeNull();
  });
});
