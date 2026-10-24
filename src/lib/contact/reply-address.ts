import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Per-thread reply address used to correlate inbound email replies back to a
 * contact inquiry thread. Format: reply+{inquiryId}.{token}@{CONTACT_INBOUND_DOMAIN}
 * where token = base64url(HMAC-SHA256(CONTACT_REPLY_SECRET, inquiryId))[:16].
 *
 * The token makes the address unguessable so a third party cannot inject
 * messages into an arbitrary thread by knowing (or guessing) an inquiry id.
 */

const TOKEN_LENGTH = 16;

function computeToken(inquiryId: string, secret: string): string {
  return createHmac('sha256', secret).update(inquiryId).digest('base64url').slice(0, TOKEN_LENGTH);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Build the Reply-To address for a thread. Returns null when the inbound email
 * feature is not configured (missing env), so callers can gracefully skip the
 * Reply-To header without failing the mail send.
 *
 * @impl IMPL-ADMIN-143
 * @design DD-ADMIN-013
 * @remarks 問い合わせの id だけの宛先では id を知る第三者が他人のスレッドに書き込めるので、秘密の鍵で作った印を添えて推測できなくする。受信の設定が整う前でもメールを送れるよう、設定が無ければ null を返して呼ぶ側に Reply-To を省かせる。DB の uuid は小文字で来るので、作る側は id をそろえずそのまま入れる（検証側は小文字にそろえて印を作り直すので、大文字の id で作った宛先は合わない）。
 */
export function buildReplyAddress(inquiryId: string): string | null {
  const domain = process.env.CONTACT_INBOUND_DOMAIN;
  const secret = process.env.CONTACT_REPLY_SECRET;
  if (!domain || !secret) {
    return null;
  }
  const token = computeToken(inquiryId, secret);
  return `reply+${inquiryId}.${token}@${domain}`;
}

/**
 * Extract and verify the inquiry id from an inbound "To" address.
 * Accepts bare addresses and "Name <addr>" forms. Returns null when no reply
 * token address is present or when the feature is not configured.
 *
 * @impl IMPL-ADMIN-144
 * @design DD-ADMIN-014
 * @remarks 偽の宛先でスレッドへ書き込まれるのを見分けるため、印を作り直して比べる。比べる時間の差から印を推し量られないよう、一定の時間の比較を使う。名前付きの宛先も受けられるよう、宛先の中から形を探す。合否を見てスレッドに取り込むかを決めるのは呼ぶ側。
 */
export function parseReplyAddress(toAddress: string): { inquiryId: string; valid: boolean } | null {
  const secret = process.env.CONTACT_REPLY_SECRET;
  if (!secret) {
    return null;
  }

  const match = toAddress.match(/reply\+([0-9a-fA-F-]{36})\.([A-Za-z0-9_-]+)@/);
  if (!match) {
    return null;
  }

  const inquiryId = match[1].toLowerCase();
  const token = match[2];
  const expected = computeToken(inquiryId, secret);
  return { inquiryId, valid: safeEqual(token, expected) };
}
