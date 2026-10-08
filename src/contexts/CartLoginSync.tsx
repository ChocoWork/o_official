'use client';

import { useEffect, useRef } from 'react';
import { useCart } from '@/contexts/CartContext';
import { useLogin } from '@/contexts/LoginContext';

/**
 * ログイン・ログアウトの後にカートとお気に入りを読み直す（本計画の決め事 P13）。ログインではサーバーが
 * ゲストの分を会員の分へ合わせるので、ヘッダーの数を合わせた後の数にする。最初の表示では読み直さない。
 */
export function CartLoginSync() {
  const { isLoggedIn, isAuthResolved } = useLogin();
  const { refreshShopping } = useCart();
  const previous = useRef<boolean | null>(null);

  useEffect(() => {
    // 最初のログインの確認が済むまでは「前の状態」を持たない。LoginProvider の isLoggedIn は false 始まりなので、
    // 会員が画面を開いた時の false から true への変化をログインと取り違えると、開いた時の読み込みが
    // 会員の分を読んだ直後にもう一度読んでしまう（読み込みを止めている /privacy でも読んでしまう）
    if (!isAuthResolved) {
      return;
    }
    if (previous.current !== null && previous.current !== isLoggedIn) {
      void refreshShopping();
    }
    previous.current = isLoggedIn;
  }, [isLoggedIn, isAuthResolved, refreshShopping]);

  return null;
}
