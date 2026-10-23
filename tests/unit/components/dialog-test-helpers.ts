import { within } from '@testing-library/react';

/**
 * Dialog の fullScreenOnMobile の見出しの行の「×」（J-12）。読み上げの名前は「閉じる」。
 * jsdom は CSS を読まないので、画面の幅に関係なく出る（ブラウザでは 768px 以上で隠れる）。
 * 画面の下の「閉じる」と名前が同じなので、それを確かめる試験はこの2つで × を外して探す。
 */
function isHeaderClose(button: HTMLElement): boolean {
  return button.hasAttribute('data-ui-dialog-close');
}

/** 画面の中のボタン（見出しの行の × を除く）。並びの順 */
export function dialogButtons(scope: HTMLElement): HTMLElement[] {
  return within(scope)
    .queryAllByRole('button')
    .filter((button) => !isHeaderClose(button));
}

/** 画面の中の「閉じる」のボタン（見出しの行の × でない方）。1つでなければ失敗にする */
export function footerCloseButton(scope: HTMLElement): HTMLElement {
  const buttons = within(scope)
    .getAllByRole('button', { name: '閉じる' })
    .filter((button) => !isHeaderClose(button));
  if (buttons.length !== 1) {
    throw new Error(`見出しの × でない「閉じる」のボタンが ${buttons.length} 個あります`);
  }
  return buttons[0];
}
