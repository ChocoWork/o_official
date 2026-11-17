/**
 * パスキーの窓口の入力の形（src/features/auth/schemas/passkey.ts）。
 *
 * @packageDocumentation
 */
import { z } from 'zod';

const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** 名前に使えない文字: C0・C1 の制御文字と、表示の向きを変える文字（双方向の制御）。 */
const NAME_FORBIDDEN_CHARS = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

const base64url = (max: number) => z.string().min(1).max(max).regex(BASE64URL);

const RegistrationResponseSchema = z.object({
  clientDataJSON: base64url(4096),
  attestationObject: base64url(16384),
  authenticatorData: base64url(8192).optional(),
  publicKey: base64url(2048).optional(),
  publicKeyAlgorithm: z.number().int().optional(),
  transports: z.array(z.string().max(32)).max(8).optional(),
});

const AuthenticationResponseSchema = z.object({
  clientDataJSON: base64url(4096),
  authenticatorData: base64url(8192),
  signature: base64url(2048),
  userHandle: base64url(256).optional(),
});

function credentialSchema<R extends z.ZodType>(response: R) {
  return z
    .object({
      id: base64url(1024),
      rawId: base64url(1024),
      type: z.literal('public-key'),
      authenticatorAttachment: z.string().max(32).optional(),
      clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
      response,
    })
    .superRefine((value, ctx) => {
      // GoTrue が署名を確かめる鍵の引き方（rawId）と、認めた鍵の突き合わせの鍵を同じにするため、id と rawId は完全に同じ値だけ受ける（SEC-AUTH-044）。
      if (value.id !== value.rawId) ctx.addIssue({ code: 'custom', path: ['rawId'], message: 'invalid_request' });
    });
}

/**
 * 応答の形。登録とログインで `response` の中身が違うので、どちらも通る形で受ける。窓口は用途ごとの形（下の2つ）を使う。
 *
 * @impl IMPL-AUTH-263
 * @design DD-AUTH-051
 */
export const PasskeyCredentialSchema = credentialSchema(
  z.union([RegistrationResponseSchema, AuthenticationResponseSchema]),
);

/**
 * ログインの終わり。
 *
 * @impl IMPL-AUTH-263
 * @design DD-AUTH-051
 */
export const PasskeyLoginFinishSchema = z.object({
  challenge_id: z.uuid(),
  credential: credentialSchema(AuthenticationResponseSchema),
  next: z.string().max(2048).optional(),
});

/**
 * 登録の終わり。
 *
 * @impl IMPL-AUTH-263
 * @design DD-AUTH-051
 */
export const PasskeyRegisterFinishSchema = z.object({
  challenge_id: z.uuid(),
  credential: credentialSchema(RegistrationResponseSchema),
});

/**
 * 名前の変更。前後の空白を除いて1〜64字（コードポイントで数える）、制御文字・表示の向きを変える文字なし。
 *
 * @impl IMPL-AUTH-263
 * @design DD-AUTH-051
 */
export const PasskeyRenameSchema = z.object({
  friendly_name: z
    .string()
    .trim()
    .min(1)
    .refine((value) => [...value].length <= 64)
    .refine((value) => !NAME_FORBIDDEN_CHARS.test(value)),
});
