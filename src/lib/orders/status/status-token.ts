// 注文の状況のトークン: 32バイトの乱数を base64url にした43文字（DB の CHECK order_status_links_token_check と同じ形）。
// 前後の空白を切り落として通さない。形が違うトークンは DB を呼ばずに「見つからない」と同じ扱いにする（P11）。
const ORDER_STATUS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isOrderStatusToken(value: unknown): value is string {
  return typeof value === 'string' && ORDER_STATUS_TOKEN_PATTERN.test(value);
}
