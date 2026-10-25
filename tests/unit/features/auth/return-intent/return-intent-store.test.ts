/** @jest-environment node */
export {};

jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));

const { createServiceRoleClient } = require('@/lib/supabase/server');
const {
  RETURN_INTENT_TOKEN_PATTERN,
  consumeReturnIntent,
  createReturnIntent,
  generateReturnIntentToken,
  hashReturnIntentToken,
} = require('@/features/auth/return-intent/return-intent-store');

function mockRpc(result: unknown) {
  const rpc = jest.fn().mockResolvedValue(result);
  createServiceRoleClient.mockResolvedValue({ rpc });
  return rpc;
}

describe('DD-AUTH-033 戻り先の控えの保存', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('DD-AUTH-033 番号は 1000 回作っても重複せず、43 文字の base64url になる', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const token = generateReturnIntentToken();
      expect(token).toHaveLength(43);
      expect(token).toMatch(RETURN_INTENT_TOKEN_PATTERN);
      expect(token).not.toMatch(/[+/=]/);
      tokens.add(token);
    }
    expect(tokens.size).toBe(1000);
  });

  it('DD-AUTH-033 番号のハッシュは sha256 の 16 進 64 桁', () => {
    const hash = hashReturnIntentToken('abc');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('DD-AUTH-033 createReturnIntent はハッシュだけを rpc に渡し、平文の番号を渡さない', async () => {
    const rpc = mockRpc({ data: 900, error: null });

    const result = await createReturnIntent({ returnPath: '/item/3?color=red', purpose: 'login' });

    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe('create_auth_return_intent');
    expect(Object.keys(args).sort()).toEqual(['_purpose', '_return_path', '_token_hash']);
    expect(args._token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(args._return_path).toBe('/item/3?color=red');
    expect(args._purpose).toBe('login');
    expect(result).not.toBeNull();
    expect(result!.token).toMatch(RETURN_INTENT_TOKEN_PATTERN);
    expect(hashReturnIntentToken(result!.token)).toBe(args._token_hash);
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(result!.token);
    expect(result!.maxAgeSeconds).toBe(900);
  });

  it('DD-AUTH-033 createReturnIntent は signup の秒数（rpc の戻り値）をそのまま Max-Age に使う', async () => {
    mockRpc({ data: 3600, error: null });
    const result = await createReturnIntent({ returnPath: '/', purpose: 'signup' });
    expect(result?.maxAgeSeconds).toBe(3600);
  });

  it('DD-AUTH-033 createReturnIntent は rpc の error で null を返し、ログに道筋・番号・ハッシュを出さない', async () => {
    const rpc = mockRpc({ data: null, error: { code: '23514', message: 'violates check /secret/path' } });

    const result = await createReturnIntent({ returnPath: '/secret/path', purpose: 'login' });

    expect(result).toBeNull();
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain('23514');
    expect(logged).not.toContain('/secret/path');
    expect(logged).not.toContain(rpc.mock.calls[0][1]._token_hash);
  });

  it('DD-AUTH-033 createReturnIntent は rpc が投げても null を返し、ログに道筋・ハッシュを出さない', async () => {
    const rpc = jest.fn().mockRejectedValue(new Error('boom /secret/path'));
    createServiceRoleClient.mockResolvedValue({ rpc });

    const result = await createReturnIntent({ returnPath: '/secret/path', purpose: 'login' });

    expect(result).toBeNull();
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain('/secret/path');
    expect(logged).not.toContain(rpc.mock.calls[0][1]._token_hash);
  });

  it('DD-AUTH-033 createReturnIntent はクライアントを作れなくても null を返す', async () => {
    createServiceRoleClient.mockRejectedValue(new Error('no client'));
    await expect(createReturnIntent({ returnPath: '/', purpose: 'login' })).resolves.toBeNull();
  });

  it.each([[null], ['900'], [0], [-1], [1.5], [undefined]])(
    'DD-AUTH-033 createReturnIntent は戻り値が正の整数でない（%p）と null',
    async (value) => {
      mockRpc({ data: value, error: null });
      await expect(createReturnIntent({ returnPath: '/', purpose: 'login' })).resolves.toBeNull();
    },
  );

  it('DD-AUTH-033 consumeReturnIntent は番号のハッシュ・用途・利用者を渡し、戻り先を返す', async () => {
    const rpc = mockRpc({ data: '/item/3', error: null });

    const result = await consumeReturnIntent({ token: 'x'.repeat(43), purpose: 'signup', userId: 'user-1' });

    expect(result).toBe('/item/3');
    expect(rpc).toHaveBeenCalledWith('consume_auth_return_intent', {
      _token_hash: hashReturnIntentToken('x'.repeat(43)),
      _purpose: 'signup',
      _user_id: 'user-1',
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('x'.repeat(43));
  });

  it('DD-AUTH-033 consumeReturnIntent は使えない（null）・空・文字列でない戻り値で null', async () => {
    for (const data of [null, '', 123, {}]) {
      mockRpc({ data, error: null });
      await expect(consumeReturnIntent({ token: 't', purpose: 'login', userId: 'u' })).resolves.toBeNull();
    }
  });

  it('DD-AUTH-033 consumeReturnIntent は error でも投げても null で、ログに番号を出さない', async () => {
    mockRpc({ data: null, error: { code: '42501', message: 'denied' } });
    await expect(consumeReturnIntent({ token: 'secret-token', purpose: 'login', userId: 'u' })).resolves.toBeNull();

    createServiceRoleClient.mockResolvedValue({ rpc: jest.fn().mockRejectedValue(new Error('secret-token')) });
    await expect(consumeReturnIntent({ token: 'secret-token', purpose: 'login', userId: 'u' })).resolves.toBeNull();

    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain('42501');
    expect(logged).not.toContain('secret-token');
    expect(logged).not.toContain(hashReturnIntentToken('secret-token'));
  });
});
