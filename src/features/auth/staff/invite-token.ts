import { createHash, randomBytes } from 'node:crypto';

/** 合言葉の元になる乱数のバイト数（base64url にすると43字） */
const TOKEN_BYTES = 32;

/**
 * 合言葉の文字列（base64url の UTF-8 のバイト）の SHA-256。生の32バイトにはかけない。
 * DB の `staff_invite_issue_manual` が表に入れる値と同じ入力にそろえる。
 */
function sha256OfString(token: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(token, 'utf8').digest());
}

/**
 * 店員の招待の合言葉を作る。32バイトの乱数の base64url（43字）と、その文字列の SHA-256 を返す。
 * 表には SHA-256 だけを入れ、合言葉はメールのリンクにだけ置く。
 *
 * @impl IMPL-AUTH-353
 * @design DD-AUTH-075
 */
export function createInviteToken(): { token: string; tokenHash: Uint8Array } {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: sha256OfString(token) };
}

/**
 * 届いた合言葉のハッシュを求める（文字列の UTF-8 の SHA-256）。`createInviteToken` が返す `tokenHash` と同じ入力。
 *
 * @impl IMPL-AUTH-354
 * @design DD-AUTH-075
 */
export function hashInviteToken(token: string): Uint8Array {
  return sha256OfString(token);
}

/**
 * 招待のリンクを作る。合言葉は URL の断片（`#`）に置く。断片はサーバーに届かないので、
 * アクセスのログにも Referer にも残らない（画面が断片を読み、POST の本文で送る）。
 *
 * @impl IMPL-AUTH-355
 * @design DD-AUTH-075
 */
export function buildInviteUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/staff/invite#${token}`;
}
