import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Svix の署名の確かめ（Resend の Webhook。お問い合わせの返信と、注文のメールの配達の状態）。
 * 届いたままの本文で HMAC-SHA256 を作り、時間差の出ない比べ方で比べる。
 * 鍵の作り直しの24時間は署名が空白で並ぶので、どれか1つが合えば通す（グループ D 設計書 6-2）。
 */
export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export function verifySvixSignature(
  secret: string,
  svixId: string,
  svixTimestamp: string,
  svixSignatureHeader: string,
  payload: string,
): boolean {
  const secretKey = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const secretBytes = Buffer.from(secretKey, 'base64');
  const signedContent = `${svixId}.${svixTimestamp}.${payload}`;
  const expected = createHmac('sha256', secretBytes).update(signedContent).digest('base64');

  const providedSignatures = svixSignatureHeader
    .split(' ')
    .map((part) => part.split(',')[1])
    .filter((value): value is string => Boolean(value));

  const expectedBuffer = Buffer.from(expected);
  return providedSignatures.some((signature) => {
    const provided = Buffer.from(signature);
    return provided.length === expectedBuffer.length && timingSafeEqual(provided, expectedBuffer);
  });
}

/** 前後5分を過ぎた知らせは断る（使い回しを防ぐ） */
export function isSvixTimestampFresh(svixTimestamp: string, nowMs: number = Date.now()): boolean {
  const timestamp = Number.parseInt(svixTimestamp, 10);
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  return Math.abs(Math.floor(nowMs / 1000) - timestamp) <= SVIX_TOLERANCE_SECONDS;
}
