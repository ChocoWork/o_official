/**
 * 画面に出す宛先をマスクする。
 *
 * 肩越しに見られてもアドレス全体を復元できないようにしつつ、「どのアカウントに
 * 送ったか」の手がかりは残す。マスク部を 3 文字固定にするのは、ローカル部の
 * 長さという情報まで漏らさないため。
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) {
    // マスクし損ねた生の値を返すくらいなら、宛先を出さない。
    return '';
  }

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const masked =
    local.length >= 5
      ? `${local.slice(0, 2)}***${local.slice(-2)}`
      : `${local.slice(0, 1)}***`;

  return `${masked}@${domain}`;
}
