export const NO_STORE_CACHE_CONTROL = 'private, no-store';

/** 応答の Cache-Control を置き換えて同じ応答を返す。状態・本文・ほかの見出し（Retry-After・Set-Cookie など）は変えない。 */
export function withNoStore<T extends Response>(response: T): T {
  response.headers.set('Cache-Control', NO_STORE_CACHE_CONTROL);
  return response;
}
