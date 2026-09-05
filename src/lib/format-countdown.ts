/**
 * 再送までの残り時間を表示用に整形する。
 *
 * ログインの OTP 再送とパスワード再設定メールの再送で同じ語彙を使う。
 * 文言を変えると e2e/FR-LOGIN-006 と e2e/FR-PWRESET-005 の両方が落ちる。
 */
export const formatResendCountdown = (timeRemaining: number) => {
  const minutes = Math.floor(timeRemaining / 60);
  const seconds = timeRemaining % 60;
  return `${minutes}分 ${String(seconds).padStart(2, "0")}秒後に再送可能`;
};
