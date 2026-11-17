/**
 * DD-AUTH-060 ブラウザの WebAuthn の部品（src/features/auth/passkey/webauthn-browser.ts）の、省かれた項目・欠けた項目の単体テスト。
 */
import { requestAssertion, requestAttestation } from '@/features/auth/passkey/webauthn-browser';

const get = jest.fn();
const create = jest.fn();
const json = {
  id: 'Y3JlZA',
  rawId: 'Y3JlZA',
  type: 'public-key',
  clientExtensionResults: {},
  response: { clientDataJSON: 'Y2xpZW50' },
};

beforeEach(() => {
  get.mockReset();
  create.mockReset();
  (window as unknown as { PublicKeyCredential: unknown }).PublicKeyCredential = function PublicKeyCredential() {};
  Object.defineProperty(navigator, 'credentials', { value: { get, create }, configurable: true });
  get.mockResolvedValue({ toJSON: () => json });
  create.mockResolvedValue({ toJSON: () => json });
});

describe('DD-AUTH-060 選択肢の省略・欠けた項目', () => {
  test('DD-AUTH-060 allowCredentials・user・excludeCredentials が無くても変換できる', async () => {
    await requestAssertion({ challenge: 'AQID', userVerification: 'required' } as never);
    await requestAttestation({ challenge: 'AQID', rp: { name: 'x' }, pubKeyCredParams: [] } as never);
    expect('allowCredentials' in get.mock.calls[0][0].publicKey).toBe(false);
    expect('user' in create.mock.calls[0][0].publicKey).toBe(false);
    expect('excludeCredentials' in create.mock.calls[0][0].publicKey).toBe(false);
  });

  test('DD-AUTH-060 id が文字列でない項目・配列でない一覧は、そのまま渡す', async () => {
    await requestAssertion({ challenge: 'AQID', allowCredentials: [{ type: 'public-key' }] } as never);
    expect(get.mock.calls[0][0].publicKey.allowCredentials).toEqual([{ type: 'public-key' }]);
    await requestAssertion({ challenge: 'AQID', allowCredentials: [null] } as never);
    expect(get.mock.calls[1][0].publicKey.allowCredentials).toEqual([null]);
    await requestAssertion({ challenge: 'AQID', allowCredentials: null } as never);
    expect(get.mock.calls[2][0].publicKey.allowCredentials).toBeNull();
  });

  test('DD-AUTH-060 getTransports が無い作成の応答は transports を付けない', async () => {
    create.mockResolvedValue({
      id: 'Y3JlZA',
      rawId: new Uint8Array([1]).buffer,
      type: 'public-key',
      getClientExtensionResults: () => ({}),
      response: { clientDataJSON: new Uint8Array([1]).buffer, attestationObject: new Uint8Array([2]).buffer },
    });
    const result = await requestAttestation({ challenge: 'AQID' } as never);
    expect(result.ok && 'transports' in (result.credential.response as object)).toBe(false);
  });
});
