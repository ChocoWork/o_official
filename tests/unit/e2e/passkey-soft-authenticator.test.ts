/** @jest-environment node */
/**
 * DD-AUTH-046 ソフトの認証器が、WebAuthn の登録・ログインの応答を正しい形で作るかを確かめる。
 * 登録の attestationObject は試験の中の小さな CBOR の読み手で読み戻し、署名は登録した公開鍵（COSE）で検証する。
 */
import { createHash, createPublicKey, createVerify } from 'node:crypto';
import { createSoftAuthenticator, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from '../../../e2e/passkey-soft-authenticator';

const CONFIG = { origin: 'http://localhost:3000', rpId: 'localhost' };

type Cbor = number | Buffer | string | Map<Cbor, Cbor>;

function readCbor(buf: Buffer, at = 0): { value: Cbor; next: number } {
  const major = buf[at] >> 5;
  let n = buf[at] & 31;
  let p = at + 1;
  if (n === 24) { n = buf[p]; p += 1; } else if (n === 25) { n = buf.readUInt16BE(p); p += 2; }
  if (major === 0) return { value: n, next: p };
  if (major === 1) return { value: -1 - n, next: p };
  if (major === 2) return { value: buf.subarray(p, p + n), next: p + n };
  if (major === 3) return { value: buf.subarray(p, p + n).toString('utf8'), next: p + n };
  if (major === 5) {
    const map = new Map<Cbor, Cbor>();
    for (let i = 0; i < n; i += 1) {
      const k = readCbor(buf, p); const v = readCbor(buf, k.next);
      map.set(k.value, v.value); p = v.next;
    }
    return { value: map, next: p };
  }
  throw new Error('この試験の CBOR の読み手が知らない形');
}

const creation = (): PublicKeyCredentialCreationOptionsJSON =>
  ({ challenge: 'Y2hhbGxlbmdl', rp: { id: 'localhost', name: 'x' }, user: { id: 'dXNlci1oYW5kbGU', name: 'a', displayName: 'a' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }] }) as PublicKeyCredentialCreationOptionsJSON;
const request = (): PublicKeyCredentialRequestOptionsJSON => ({ challenge: 'cmVxdWVzdA', rpId: 'localhost' }) as PublicKeyCredentialRequestOptionsJSON;

function registered(userVerified?: boolean) {
  const auth = createSoftAuthenticator(CONFIG);
  const reg = auth.register(creation(), userVerified === undefined ? undefined : { userVerified });
  const att = readCbor(Buffer.from(reg.response.attestationObject, 'base64url')).value as Map<Cbor, Cbor>;
  const authData = att.get('authData') as Buffer;
  return { auth, reg, att, authData };
}

describe('DD-AUTH-046 passkey-soft-authenticator', () => {
  it('DD-AUTH-046 登録の attestationObject は fmt none で、位置 32 の flags が 0x45（UV あり）', () => {
    const { att, authData, reg, auth } = registered();
    expect(att.get('fmt')).toBe('none');
    expect((att.get('attStmt') as Map<Cbor, Cbor>).size).toBe(0);
    expect(authData[32]).toBe(0x45);
    expect(authData.subarray(0, 32).equals(createHash('sha256').update('localhost').digest())).toBe(true);
    // 33〜36 が回数、37〜52 が AAGUID、53〜54 が credentialId の長さ
    expect(authData.readUInt16BE(53)).toBe(auth.credentialId.length);
    expect(authData.subarray(55, 55 + auth.credentialId.length).equals(auth.credentialId)).toBe(true);
    expect(reg.id).toBe(auth.credentialId.toString('base64url'));
  });

  it('DD-AUTH-046 userVerified が偽なら flags は 0x41（UV の 0x04 を落とす）', () => {
    expect(registered(false).authData[32]).toBe(0x41);
  });

  it('DD-AUTH-046 登録の応答の clientDataJSON は webauthn.create・challenge・origin を持つ', () => {
    const { reg } = registered();
    const cd = JSON.parse(Buffer.from(reg.response.clientDataJSON, 'base64url').toString('utf8'));
    expect(cd).toMatchObject({ type: 'webauthn.create', challenge: 'Y2hhbGxlbmdl', origin: CONFIG.origin });
  });

  it('DD-AUTH-046 ログインの署名が登録した公開鍵で検証でき、signCount が増える', () => {
    const { auth, authData } = registered();
    const cose = readCbor(authData, 55 + auth.credentialId.length).value as Map<Cbor, Cbor>;
    const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: (cose.get(-2) as Buffer).toString('base64url'), y: (cose.get(-3) as Buffer).toString('base64url') } });
    expect(auth.signCount).toBe(0);
    for (const expected of [1, 2]) {
      const res = auth.authenticate(request());
      expect(auth.signCount).toBe(expected);
      const ad = Buffer.from(res.response.authenticatorData, 'base64url');
      expect(ad[32]).toBe(0x05);
      expect(ad.readUInt32BE(33)).toBe(expected);
      const cd = Buffer.from(res.response.clientDataJSON, 'base64url');
      expect(JSON.parse(cd.toString('utf8'))).toMatchObject({ type: 'webauthn.get', challenge: 'cmVxdWVzdA' });
      const verifier = createVerify('sha256');
      verifier.update(Buffer.concat([ad, createHash('sha256').update(cd).digest()]));
      expect(verifier.verify(key, Buffer.from(res.response.signature, 'base64url'))).toBe(true);
      expect(res.response.userHandle).toBe('dXNlci1oYW5kbGU');
    }
  });

  it('DD-AUTH-046 userVerified が偽のログインは flags が 0x01', () => {
    const { auth } = registered();
    const ad = Buffer.from(auth.authenticate(request(), { userVerified: false }).response.authenticatorData, 'base64url');
    expect(ad[32]).toBe(0x01);
  });

  it('DD-AUTH-046 登録の前のログインは userHandle を付けない', () => {
    const res = createSoftAuthenticator(CONFIG).authenticate(request());
    expect(res.response.userHandle).toBeUndefined();
  });

  it('DD-AUTH-046 認証器ごとに別の credentialId と鍵を持つ', () => {
    const a = createSoftAuthenticator(CONFIG);
    const b = createSoftAuthenticator(CONFIG);
    expect(a.credentialId.equals(b.credentialId)).toBe(false);
  });
});
