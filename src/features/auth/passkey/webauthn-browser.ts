/**
 * ブラウザの WebAuthn の呼び出し（src/features/auth/passkey/webauthn-browser.ts）。
 * 窓口が返した選択肢（JSON）を `navigator.credentials` に渡し、応答を JSON にして返す。画面は持たない。
 *
 * @packageDocumentation
 * @remarks 型だけを `@supabase/supabase-js` から `import type` で読む。`@/lib/auth/passkey-gotrue`・`@/lib/auth/passkey-start-config` は読まない
 * （`server-only` を付けたため、ブラウザの束に入るとビルドが落ちる）。`challenge`・応答の中身はログに出さない（このファイルは何も出力しない）。
 */
import type {
  PasskeyAuthenticationOptionsResponse,
  PasskeyAuthenticationVerifyParams,
  PasskeyRegistrationOptionsResponse,
  PasskeyRegistrationVerifyParams,
} from '@supabase/supabase-js';

export type PublicKeyCredentialRequestOptionsJSON = PasskeyAuthenticationOptionsResponse['options'];
export type PublicKeyCredentialCreationOptionsJSON = PasskeyRegistrationOptionsResponse['options'];
export type AuthenticationResponseJSON = PasskeyAuthenticationVerifyParams['credential'];
export type RegistrationResponseJSON = PasskeyRegistrationVerifyParams['credential'];

export type PasskeyFailureReason = 'cancelled' | 'already_registered' | 'unsupported' | 'failed';
export type AssertionResult =
  | { ok: true; credential: AuthenticationResponseJSON }
  | { ok: false; reason: PasskeyFailureReason };
export type AttestationResult =
  | { ok: true; credential: RegistrationResponseJSON }
  | { ok: false; reason: PasskeyFailureReason };

type Json = Record<string, unknown>;

/**
 * `window.PublicKeyCredential` と `navigator.credentials` の両方が在る時だけ真。
 *
 * @impl IMPL-AUTH-312
 * @design DD-AUTH-060
 */
export function isPasskeySupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.credentials
  );
}

function base64urlToBuffer(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bufferToBase64url(buffer: ArrayBuffer | null | undefined): string | undefined {
  if (!buffer) return undefined;
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function withBufferIds(list: unknown): unknown {
  if (!Array.isArray(list)) return list;
  return list.map((item) => {
    const entry = item as Json;
    return typeof entry?.id === 'string' ? { ...entry, id: base64urlToBuffer(entry.id) } : entry;
  });
}

type CredentialStatics = {
  parseRequestOptionsFromJSON?: (options: unknown) => PublicKeyCredentialRequestOptions;
  parseCreationOptionsFromJSON?: (options: unknown) => PublicKeyCredentialCreationOptions;
};

function toRequestOptions(options: PublicKeyCredentialRequestOptionsJSON): PublicKeyCredentialRequestOptions {
  const statics = window.PublicKeyCredential as unknown as CredentialStatics;
  if (typeof statics.parseRequestOptionsFromJSON === 'function') return statics.parseRequestOptionsFromJSON(options);
  const json = options as unknown as Json;
  return {
    ...json,
    challenge: base64urlToBuffer(String(json.challenge)),
    ...(json.allowCredentials !== undefined ? { allowCredentials: withBufferIds(json.allowCredentials) } : {}),
  } as unknown as PublicKeyCredentialRequestOptions;
}

function toCreationOptions(options: PublicKeyCredentialCreationOptionsJSON): PublicKeyCredentialCreationOptions {
  const statics = window.PublicKeyCredential as unknown as CredentialStatics;
  if (typeof statics.parseCreationOptionsFromJSON === 'function') return statics.parseCreationOptionsFromJSON(options);
  const json = options as unknown as Json;
  const user = json.user as Json | undefined;
  return {
    ...json,
    challenge: base64urlToBuffer(String(json.challenge)),
    ...(user && typeof user.id === 'string' ? { user: { ...user, id: base64urlToBuffer(user.id) } } : {}),
    ...(json.excludeCredentials !== undefined ? { excludeCredentials: withBufferIds(json.excludeCredentials) } : {}),
  } as unknown as PublicKeyCredentialCreationOptions;
}

/** 実ブラウザの `toJSON()` は、無い項目を `null` で返すことがある（`authenticatorAttachment`）。窓口の形に合わせて落とす。 */
function dropNulls(json: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(json)) if (value !== null && value !== undefined) out[key] = value;
  return out;
}

function fromToJson(credential: PublicKeyCredential): Json | null {
  const withJson = credential as PublicKeyCredential & { toJSON?: () => Json };
  if (typeof withJson.toJSON !== 'function') return null;
  const json = dropNulls(withJson.toJSON());
  if (json.response && typeof json.response === 'object') json.response = dropNulls(json.response as Json);
  return json;
}

function serializeAssertion(credential: PublicKeyCredential): AuthenticationResponseJSON {
  const viaJson = fromToJson(credential);
  if (viaJson) return viaJson as unknown as AuthenticationResponseJSON;
  const response = credential.response as AuthenticatorAssertionResponse;
  return dropNulls({
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: dropNulls({
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      authenticatorData: bufferToBase64url(response.authenticatorData),
      signature: bufferToBase64url(response.signature),
      userHandle: bufferToBase64url(response.userHandle),
    }),
  }) as unknown as AuthenticationResponseJSON;
}

function serializeAttestation(credential: PublicKeyCredential): RegistrationResponseJSON {
  const viaJson = fromToJson(credential);
  if (viaJson) return viaJson as unknown as RegistrationResponseJSON;
  const response = credential.response as AuthenticatorAttestationResponse;
  const transports = typeof response.getTransports === 'function' ? response.getTransports() : undefined;
  return dropNulls({
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: dropNulls({
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      attestationObject: bufferToBase64url(response.attestationObject),
      transports,
    }),
  }) as unknown as RegistrationResponseJSON;
}

function reasonFromError(error: unknown): PasskeyFailureReason {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'NotAllowedError') return 'cancelled';
  if (name === 'InvalidStateError') return 'already_registered';
  if (name === 'NotSupportedError' || name === 'SecurityError') return 'unsupported';
  return 'failed';
}

/**
 * 鍵でログインする（`navigator.credentials.get`）。`authenticatorAttachment` が `null` なら落として返す。
 *
 * @impl IMPL-AUTH-302
 * @design DD-AUTH-060
 */
export async function requestAssertion(options: PublicKeyCredentialRequestOptionsJSON): Promise<AssertionResult> {
  if (!isPasskeySupported()) return { ok: false, reason: 'unsupported' };
  try {
    const credential = (await navigator.credentials.get({
      publicKey: toRequestOptions(options),
    })) as PublicKeyCredential | null;
    if (!credential) return { ok: false, reason: 'failed' };
    return { ok: true, credential: serializeAssertion(credential) };
  } catch (error) {
    return { ok: false, reason: reasonFromError(error) };
  }
}

/**
 * 鍵を作る（`navigator.credentials.create`）。`authenticatorAttachment` が `null` なら落として返す。
 *
 * @impl IMPL-AUTH-303
 * @design DD-AUTH-060
 */
export async function requestAttestation(options: PublicKeyCredentialCreationOptionsJSON): Promise<AttestationResult> {
  if (!isPasskeySupported()) return { ok: false, reason: 'unsupported' };
  try {
    const credential = (await navigator.credentials.create({
      publicKey: toCreationOptions(options),
    })) as PublicKeyCredential | null;
    if (!credential) return { ok: false, reason: 'failed' };
    return { ok: true, credential: serializeAttestation(credential) };
  } catch (error) {
    return { ok: false, reason: reasonFromError(error) };
  }
}
