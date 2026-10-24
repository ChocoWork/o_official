// File: src/lib/admin/admin-load-failure.ts
// 管理画面の読込が失敗した時に出す文を決める（G-0 の /admin/settings/permissions と同じ順）。
// 窓口は MFA が無い時も 403 を返すので、状態の番号より先に本文の reason を見る。
// これを通さないと、MFA が無いだけの人に「権限がありません」と誤って出してしまう。

/**
 * @param status 窓口の HTTP 状態
 * @param body 窓口の本文（読めなければ null など。形は問わない）
 * @param forbiddenText MFA の知らせが無い 403 の時に出す、その画面の権限の文
 * @param failedText それ以外の失敗の時に出す、その画面の失敗の文
 */
export function adminLoadFailureMessage(status: number, body: unknown, forbiddenText: string, failedText: string): string {
  if (typeof body === 'object' && body !== null && (body as { reason?: unknown }).reason === 'MFA required') {
    return '2要素認証が必要です';
  }
  if (status === 401) return 'ログインし直してください。';
  if (status === 403) return forbiddenText;
  return failedText;
}
