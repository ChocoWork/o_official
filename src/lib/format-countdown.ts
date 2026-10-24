/**
 * 再送までの残り時間を表示用に整形する。
 *
 * @impl IMPL-AUTH-144
 * @design DD-AUTH-013
 * @remarks ログインの OTP 再送とパスワード再設定メールの再送で同じ語彙を使う。
 * 文言を変えると両方の画面の期待が同時に崩れる。
 */
export const formatResendCountdown = (timeRemaining: number) => {
  const minutes = Math.floor(timeRemaining / 60);
  const seconds = timeRemaining % 60;
  return `${minutes}分 ${String(seconds).padStart(2, "0")}秒後に再送可能`;
};
