/**
 * 店員が Google・メールのコード・古いパスワードで入ろうとした時にログイン画面とメールのコードの画面が出す、固定の1文。
 *
 * @impl IMPL-AUTH-389
 * @design DD-AUTH-083
 * @remarks 文は1つだけにそろえる（設計 6-2 の文から「方」を足した。オーナーの確認待ち）。`error` の値は呼び手が確かめた固定の値だけを渡し、問い合わせの文字をそのまま出さない。
 */
export function staffPasskeyRequiredMessage(): string {
  return '店員の方は、パスキーでログインしてください。';
}
