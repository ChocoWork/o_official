/**
 * パスキーの応答から、利用者の確認（UV）の印を読む（src/lib/auth/passkey-uv.ts）。外のライブラリを足さず、小さな CBOR の読み取りを自前で持つ。
 *
 * @packageDocumentation
 */

const FLAGS_OFFSET = 32;
const MIN_AUTHENTICATOR_DATA_LENGTH = 37;
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const MAX_CBOR_DEPTH = 8;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * base64url の形か。`Buffer.from` は不正な文字を黙って捨てるので、先に形を確かめる（長さが4で割って1余るものも不可）。
 *
 * @impl IMPL-AUTH-254
 * @design DD-AUTH-051
 */
export function isBase64Url(value: unknown): value is string {
  return typeof value === 'string' && BASE64URL_PATTERN.test(value) && value.length % 4 !== 1;
}

/**
 * `authenticatorData`（base64url）の位置 32 の flags から、UP（0x01）・UV（0x04）を読む。
 * 文字列でない・base64url でない・37バイト未満は `null`。
 *
 * @impl IMPL-AUTH-255
 * @design DD-AUTH-051
 */
export function readAuthenticatorDataFlags(
  authenticatorDataB64Url: unknown,
): { userPresent: boolean; userVerified: boolean } | null {
  if (!isBase64Url(authenticatorDataB64Url)) return null;
  const bytes = Buffer.from(authenticatorDataB64Url, 'base64url');
  if (bytes.length < MIN_AUTHENTICATOR_DATA_LENGTH) return null;
  const flags = bytes[FLAGS_OFFSET];
  return { userPresent: (flags & FLAG_UP) !== 0, userVerified: (flags & FLAG_UV) !== 0 };
}

class CborError extends Error {}

type CborValue = number | boolean | null | Uint8Array | string | CborValue[] | Map<CborValue, CborValue>;

/** 長さ・値の引数（追加情報）を読む。不定長（31）・予約（28〜30）・8バイトの長さは扱わず失敗にする。 */
function readArgument(buf: Uint8Array, at: number, info: number): { n: number; next: number } {
  if (info < 24) return { n: info, next: at };
  const widths: Record<number, number> = { 24: 1, 25: 2, 26: 4 };
  const width = widths[info];
  if (!width || at + width > buf.length) throw new CborError();
  let n = 0;
  for (let i = 0; i < width; i += 1) n = n * 256 + buf[at + i];
  return { n, next: at + width };
}

function readItem(buf: Uint8Array, at: number, depth: number): { value: CborValue; next: number } {
  if (at >= buf.length) throw new CborError();
  const major = buf[at] >> 5;
  const info = buf[at] & 31;
  if (major === 7) {
    if (info === 20) return { value: false, next: at + 1 };
    if (info === 21) return { value: true, next: at + 1 };
    if (info === 22) return { value: null, next: at + 1 };
    throw new CborError();
  }
  const { n, next } = readArgument(buf, at + 1, info);
  if (major === 0) return { value: n, next };
  if (major === 1) return { value: -1 - n, next };
  if (major === 2 || major === 3) {
    if (next + n > buf.length) throw new CborError();
    const bytes = buf.subarray(next, next + n);
    return { value: major === 2 ? bytes : Buffer.from(bytes).toString('utf8'), next: next + n };
  }
  if (major === 4 || major === 5) {
    if (depth + 1 > MAX_CBOR_DEPTH) throw new CborError();
    const count = major === 5 ? n * 2 : n;
    // 1項目は最低1バイトなので、残りより多い項目数は偽りの長さ（大きな繰り返しを避ける）
    if (count > buf.length - next) throw new CborError();
    let p = next;
    const items: CborValue[] = [];
    for (let i = 0; i < count; i += 1) {
      const item = readItem(buf, p, depth + 1);
      items.push(item.value);
      p = item.next;
    }
    if (major === 4) return { value: items, next: p };
    const map = new Map<CborValue, CborValue>();
    for (let i = 0; i < items.length; i += 2) map.set(items[i], items[i + 1]);
    return { value: map, next: p };
  }
  throw new CborError();
}

/**
 * 登録の `attestationObject`（base64url の CBOR。map の `fmt`・`attStmt`・`authData`）から、`authData` の UV の印を読む。
 * 読めない・途中で切れた・余りがある・深さ8超・`authData` が無い・短すぎる時は `null`。
 *
 * @impl IMPL-AUTH-256
 * @design DD-AUTH-051
 * @remarks 登録の確かめは「使えない鍵を数に入れない」ための参考で、安全の門はログインの終わり（設計 5-3）。
 */
export function readAttestationUserVerified(attestationObjectB64Url: unknown): boolean | null {
  if (!isBase64Url(attestationObjectB64Url)) return null;
  const bytes = Buffer.from(attestationObjectB64Url, 'base64url');
  try {
    const { value, next } = readItem(bytes, 0, 0);
    if (next !== bytes.length || !(value instanceof Map)) return null;
    const authData = value.get('authData');
    if (!(authData instanceof Uint8Array) || authData.length < MIN_AUTHENTICATOR_DATA_LENGTH) return null;
    return (authData[FLAGS_OFFSET] & FLAG_UV) !== 0;
  } catch {
    return null;
  }
}
