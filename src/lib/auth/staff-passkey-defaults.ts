/**
 * 店員のパスキーの設定の初めの値（DB の `private.passkey_staff_config` の行の既定値と同じにする）。
 *
 * @impl IMPL-AUTH-240
 * @design DD-AUTH-043
 * @remarks 値を変える時は DB の設定の行と同じコミットで両方を変える（ADR-0464）。単体テストが移行の既定値との一致を確かめる。
 */
export function defaultStaffPasskeySettings() {
  return {
    staffMaxSessionSeconds: 86400,
    staffIdleSeconds: 3600,
    windowMinutes: 30,
    minApprovedPasskeys: 2,
    rejectCustomerPassword: false,
  } as const;
}
