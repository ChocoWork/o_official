/**
 * 試験用のソフトの WebAuthn 認証器。手元の Supabase（GoTrue）のパスキーの登録・ログインを、ブラウザ無しで通すための道具。
 *
 * ES256 の鍵の対を node:crypto で作り、attestation は `none` で返す。CBOR は登録の応答に要る形だけを手で書く（外のライブラリは足さない）。
 * 本番に試験専用の入口は作らない。この道具は試験・手元の開発のスクリプトからだけ読まれ、アプリのコードは読まない。
 */
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { PasskeyAuthenticationOptionsResponse, PasskeyRegistrationOptionsResponse, PasskeyRegistrationVerifyParams, PasskeyAuthenticationVerifyParams } from '@supabase/supabase-js';

export type PublicKeyCredentialCreationOptionsJSON = PasskeyRegistrationOptionsResponse['options'];
export type PublicKeyCredentialRequestOptionsJSON = PasskeyAuthenticationOptionsResponse['options'];
export type RegistrationResponseJSON = PasskeyRegistrationVerifyParams['credential'];
export type AuthenticationResponseJSON = PasskeyAuthenticationVerifyParams['credential'];

export type SoftAuthenticator = {
  credentialId: Buffer;
  signCount: number;
  /** 登録の応答。公開鍵の COSE 形と credentialId を含む attestationObject（fmt は none）を返す */
  register(options: PublicKeyCredentialCreationOptionsJSON, opts?: { userVerified?: boolean }): RegistrationResponseJSON;
  /** ログインの応答。signCount を 1 増やして、authenticatorData || SHA-256(clientDataJSON) に署名する */
  authenticate(options: PublicKeyCredentialRequestOptionsJSON, opts?: { userVerified?: boolean }): AuthenticationResponseJSON;
};

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

function b64u(buf: Buffer): string {
  return buf.toString('base64url');
}

/** CBOR の見出し（major type と長さ）。この道具が書く値は 65535 バイト以下。1・2バイトの長さの分かれ目を試験が確かめるので export する */
export function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
}
const cborInt = (n: number): Buffer => (n >= 0 ? cborHead(0, n) : cborHead(1, -1 - n));
const cborBytes = (b: Buffer): Buffer => Buffer.concat([cborHead(2, b.length), b]);
const cborText = (s: string): Buffer => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([cborHead(3, b.length), b]);
};
const cborMap = (entries: Array<[Buffer, Buffer]>): Buffer =>
  Buffer.concat([cborHead(5, entries.length), ...entries.flatMap(([k, v]) => [k, v])]);

/**
 * 1本分のソフトの認証器を作る。1本ごとに別の鍵・credentialId を持つ。
 *
 * @impl IMPL-AUTH-243
 * @design DD-AUTH-046
 * @remarks flags の位置は authenticatorData の先頭から数えて 32（相手の名前の指紋 32 バイトの次の 1 バイト）。
 * UP=0x01、UV=0x04、AT=0x40。UV の有無をサーバーの確かめ（5-3 の門）が見るので、引数で落とせるようにしている。
 */
export function createSoftAuthenticator(config: { origin: string; rpId: string }): SoftAuthenticator {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const credentialId = randomBytes(32);
  const rpIdHash = createHash('sha256').update(config.rpId).digest();
  let userHandle: string | undefined;

  const state: SoftAuthenticator = {
    credentialId,
    signCount: 0,
    register(options, opts) {
      const uv = opts?.userVerified ?? true;
      userHandle = options.user.id;
      const clientDataJSON = Buffer.from(
        JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: config.origin, crossOrigin: false }),
        'utf8',
      );
      // COSE_Key（EC2・ES256・P-256）。キーの並びは RFC 8152 の整列順（1, 3, -1, -2, -3）
      const coseKey = cborMap([
        [cborInt(1), cborInt(2)],
        [cborInt(3), cborInt(-7)],
        [cborInt(-1), cborInt(1)],
        [cborInt(-2), cborBytes(Buffer.from(jwk.x, 'base64url'))],
        [cborInt(-3), cborBytes(Buffer.from(jwk.y, 'base64url'))],
      ]);
      const idLen = Buffer.alloc(2);
      idLen.writeUInt16BE(credentialId.length);
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(state.signCount);
      const flags = FLAG_UP | FLAG_AT | (uv ? FLAG_UV : 0);
      const authData = Buffer.concat([rpIdHash, Buffer.from([flags]), counter, Buffer.alloc(16), idLen, credentialId, coseKey]);
      const attestationObject = cborMap([
        [cborText('fmt'), cborText('none')],
        [cborText('attStmt'), cborMap([])],
        [cborText('authData'), cborBytes(authData)],
      ]);
      return {
        id: b64u(credentialId),
        rawId: b64u(credentialId),
        type: 'public-key',
        authenticatorAttachment: 'platform',
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64u(clientDataJSON),
          attestationObject: b64u(attestationObject),
          authenticatorData: b64u(authData),
          transports: ['internal'],
        },
      } as RegistrationResponseJSON;
    },
    authenticate(options, opts) {
      const uv = opts?.userVerified ?? true;
      state.signCount += 1;
      const clientDataJSON = Buffer.from(
        JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: config.origin, crossOrigin: false }),
        'utf8',
      );
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(state.signCount);
      const authData = Buffer.concat([rpIdHash, Buffer.from([FLAG_UP | (uv ? FLAG_UV : 0)]), counter]);
      const signer = createSign('sha256');
      signer.update(Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]));
      const signature = signer.sign(privateKey);
      return {
        id: b64u(credentialId),
        rawId: b64u(credentialId),
        type: 'public-key',
        authenticatorAttachment: 'platform',
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64u(clientDataJSON),
          authenticatorData: b64u(authData),
          signature: b64u(signature),
          ...(userHandle ? { userHandle } : {}),
        },
      } as AuthenticationResponseJSON;
    },
  };
  return state;
}
