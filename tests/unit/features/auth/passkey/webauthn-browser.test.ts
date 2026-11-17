/**
 * DD-AUTH-060 ブラウザの WebAuthn の呼び出し（src/features/auth/passkey/webauthn-browser.ts）の単体テスト。
 */
import { isPasskeySupported, requestAssertion, requestAttestation } from '@/features/auth/passkey/webauthn-browser';

const get = jest.fn();
const create = jest.fn();

function setSupport(options: { statics?: Record<string, unknown> | null; credentials?: boolean } = {}) {
  const { statics = {}, credentials = true } = options;
  if (statics === null) {
    delete (window as unknown as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  } else {
    (window as unknown as { PublicKeyCredential: unknown }).PublicKeyCredential = Object.assign(function PublicKeyCredential() {}, statics);
  }
  Object.defineProperty(navigator, 'credentials', {
    value: credentials ? { get, create } : undefined,
    configurable: true,
  });
}

const bytes = (buffer: unknown) => Array.from(new Uint8Array(buffer as ArrayBuffer));

const requestOptions = {
  challenge: 'AQID',
  rpId: 'localhost',
  userVerification: 'required',
  allowCredentials: [{ id: '-_8', type: 'public-key' }],
};
const creationOptions = {
  challenge: 'AQID',
  rp: { name: 'x', id: 'localhost' },
  user: { id: 'BAUG', name: 'a@example.com', displayName: 'a' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  excludeCredentials: [{ id: '-_8', type: 'public-key' }],
};

const assertionJson = (overrides: Record<string, unknown> = {}) => ({
  id: 'Y3JlZA',
  rawId: 'Y3JlZA',
  type: 'public-key',
  authenticatorAttachment: null,
  clientExtensionResults: {},
  response: { clientDataJSON: 'Y2xpZW50', authenticatorData: 'YXV0aA', signature: 'c2ln', userHandle: null },
  ...overrides,
});

beforeEach(() => {
  get.mockReset();
  create.mockReset();
  setSupport();
});

describe('DD-AUTH-060 isPasskeySupported', () => {
  test('DD-AUTH-060 PublicKeyCredential と navigator.credentials の両方が在れば真', () => {
    expect(isPasskeySupported()).toBe(true);
  });

  test('DD-AUTH-060 PublicKeyCredential が無ければ偽、requestAssertion・requestAttestation は unsupported', async () => {
    setSupport({ statics: null });
    expect(isPasskeySupported()).toBe(false);
    await expect(requestAssertion(requestOptions as never)).resolves.toEqual({ ok: false, reason: 'unsupported' });
    await expect(requestAttestation(creationOptions as never)).resolves.toEqual({ ok: false, reason: 'unsupported' });
    expect(get).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  test('DD-AUTH-060 navigator.credentials が無ければ偽', () => {
    setSupport({ credentials: false });
    expect(isPasskeySupported()).toBe(false);
  });
});

describe('DD-AUTH-060 選択肢の ArrayBuffer への変換（自前）', () => {
  test('DD-AUTH-060 parse*FromJSON が無い環境で、challenge・allowCredentials[].id を直す', async () => {
    get.mockResolvedValue({ toJSON: () => assertionJson() });
    await requestAssertion(requestOptions as never);
    const publicKey = get.mock.calls[0][0].publicKey;
    expect(bytes(publicKey.challenge)).toEqual([1, 2, 3]);
    expect(bytes(publicKey.allowCredentials[0].id)).toEqual([0xfb, 0xff]);
    expect(publicKey.rpId).toBe('localhost');
    expect(publicKey.userVerification).toBe('required');
  });

  test('DD-AUTH-060 作成の選択肢は challenge・user.id・excludeCredentials[].id を直す', async () => {
    create.mockResolvedValue({ toJSON: () => ({ ...assertionJson(), response: { clientDataJSON: 'Y2xpZW50', attestationObject: 'YXR0' } }) });
    await requestAttestation(creationOptions as never);
    const publicKey = create.mock.calls[0][0].publicKey;
    expect(bytes(publicKey.challenge)).toEqual([1, 2, 3]);
    expect(bytes(publicKey.user.id)).toEqual([4, 5, 6]);
    expect(publicKey.user.name).toBe('a@example.com');
    expect(bytes(publicKey.excludeCredentials[0].id)).toEqual([0xfb, 0xff]);
  });

  test('DD-AUTH-060 parse*FromJSON が在る環境では、それを使う', async () => {
    const parsedRequest = { challenge: new Uint8Array([9]).buffer };
    const parsedCreation = { challenge: new Uint8Array([8]).buffer };
    const parseRequestOptionsFromJSON = jest.fn(() => parsedRequest);
    const parseCreationOptionsFromJSON = jest.fn(() => parsedCreation);
    setSupport({ statics: { parseRequestOptionsFromJSON, parseCreationOptionsFromJSON } });
    get.mockResolvedValue({ toJSON: () => assertionJson() });
    create.mockResolvedValue({ toJSON: () => assertionJson() });

    await requestAssertion(requestOptions as never);
    await requestAttestation(creationOptions as never);

    expect(parseRequestOptionsFromJSON).toHaveBeenCalledWith(requestOptions);
    expect(parseCreationOptionsFromJSON).toHaveBeenCalledWith(creationOptions);
    expect(get.mock.calls[0][0]).toEqual({ publicKey: parsedRequest });
    expect(create.mock.calls[0][0]).toEqual({ publicKey: parsedCreation });
  });
});

describe('DD-AUTH-060 応答の JSON 化と null の項目', () => {
  test('DD-AUTH-060 toJSON() が authenticatorAttachment: null を返しても、戻りに null が残らない', async () => {
    get.mockResolvedValue({ toJSON: () => assertionJson() });
    const result = await requestAssertion(requestOptions as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const credential = result.credential as unknown as Record<string, unknown>;
    expect('authenticatorAttachment' in credential).toBe(false);
    expect('userHandle' in (credential.response as object)).toBe(false);
    expect(JSON.stringify(credential)).not.toContain('null');
    expect(credential.id).toBe('Y3JlZA');
  });

  test('DD-AUTH-060 authenticatorAttachment が文字列なら残す（登録も同じ）', async () => {
    create.mockResolvedValue({ toJSON: () => assertionJson({ authenticatorAttachment: 'platform' }) });
    const result = await requestAttestation(creationOptions as never);
    expect(result.ok && (result.credential as unknown as Record<string, unknown>).authenticatorAttachment).toBe('platform');
    create.mockResolvedValue({ toJSON: () => assertionJson({ authenticatorAttachment: null }) });
    const dropped = await requestAttestation(creationOptions as never);
    expect(dropped.ok && 'authenticatorAttachment' in dropped.credential).toBe(false);
  });

  test('DD-AUTH-060 toJSON() が無ければ自前で組み、null の項目を付けない', async () => {
    get.mockResolvedValue({
      id: 'Y3JlZA',
      rawId: new Uint8Array([0x63, 0x72, 0x65, 0x64]).buffer,
      type: 'public-key',
      authenticatorAttachment: null,
      getClientExtensionResults: () => ({}),
      response: {
        clientDataJSON: new Uint8Array([1]).buffer,
        authenticatorData: new Uint8Array([2]).buffer,
        signature: new Uint8Array([3]).buffer,
        userHandle: null,
      },
    });
    const result = await requestAssertion(requestOptions as never);
    expect(result).toEqual({
      ok: true,
      credential: {
        id: 'Y3JlZA',
        rawId: 'Y3JlZA',
        type: 'public-key',
        clientExtensionResults: {},
        response: { clientDataJSON: 'AQ', authenticatorData: 'Ag', signature: 'Aw' },
      },
    });
  });

  test('DD-AUTH-060 作成も toJSON() が無ければ自前で組む（transports を含む）', async () => {
    create.mockResolvedValue({
      id: 'Y3JlZA',
      rawId: new Uint8Array([0x63, 0x72, 0x65, 0x64]).buffer,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      getClientExtensionResults: () => ({}),
      response: {
        clientDataJSON: new Uint8Array([1]).buffer,
        attestationObject: new Uint8Array([2]).buffer,
        getTransports: () => ['internal'],
      },
    });
    const result = await requestAttestation(creationOptions as never);
    expect(result).toEqual({
      ok: true,
      credential: {
        id: 'Y3JlZA',
        rawId: 'Y3JlZA',
        type: 'public-key',
        authenticatorAttachment: 'platform',
        clientExtensionResults: {},
        response: { clientDataJSON: 'AQ', attestationObject: 'Ag', transports: ['internal'] },
      },
    });
  });

  test('DD-AUTH-060 credentials が null を返したら failed', async () => {
    get.mockResolvedValue(null);
    create.mockResolvedValue(null);
    await expect(requestAssertion(requestOptions as never)).resolves.toEqual({ ok: false, reason: 'failed' });
    await expect(requestAttestation(creationOptions as never)).resolves.toEqual({ ok: false, reason: 'failed' });
  });
});

describe('DD-AUTH-060 DOMException の対応', () => {
  test.each([
    ['NotAllowedError', 'cancelled'],
    ['InvalidStateError', 'already_registered'],
    ['NotSupportedError', 'unsupported'],
    ['SecurityError', 'unsupported'],
    ['AbortError', 'failed'],
    ['TypeError', 'failed'],
  ])('DD-AUTH-060 %s は %s', async (name, reason) => {
    get.mockRejectedValue(new DOMException('x', name));
    create.mockRejectedValue(new DOMException('x', name));
    await expect(requestAssertion(requestOptions as never)).resolves.toEqual({ ok: false, reason });
    await expect(requestAttestation(creationOptions as never)).resolves.toEqual({ ok: false, reason });
  });

  test('DD-AUTH-060 例外でない値が投げられても failed', async () => {
    get.mockRejectedValue(undefined);
    await expect(requestAssertion(requestOptions as never)).resolves.toEqual({ ok: false, reason: 'failed' });
  });
});

describe('DD-AUTH-060 ログに中身を出さない', () => {
  test('DD-AUTH-060 成功・失敗のどちらでも、challenge・応答を console に出さない', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) => jest.spyOn(console, name).mockImplementation(() => {}));
    get.mockResolvedValueOnce({ toJSON: () => assertionJson() }).mockRejectedValueOnce(new DOMException('AQID', 'NotAllowedError'));
    await requestAssertion(requestOptions as never);
    await requestAssertion(requestOptions as never);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    spies.forEach((spy) => spy.mockRestore());
  });
});
