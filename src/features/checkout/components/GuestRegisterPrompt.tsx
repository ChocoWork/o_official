'use client';

import { Button } from '@/components/ui/Button/Button';

/**
 * 注文完了画面の会員登録カード。未ログインのときだけ描画する。
 *
 * メールだけをクエリで渡す。住所や電話を URL に載せると、
 * ブラウザ履歴・Referrer に個人情報が残る。配送先は会員登録の
 * メール確認が済んだあとにサーバー側で profiles へ引き継ぐ。
 */
export function GuestRegisterPrompt({ email }: { email: string }) {
  const href = `/register?email=${encodeURIComponent(email)}`;

  return (
    <section
      aria-label="会員登録のご案内"
      className="mt-6 border border-[#d4d4d4] bg-white px-5 py-4"
    >
      <h3 className="font-acumin text-sm tracking-widest text-black">
        次回から入力不要になります
      </h3>
      <p className="mt-2 font-acumin text-xs leading-relaxed text-[#474747]">
        会員登録すると、このご注文がマイページに表示され、お届け先も引き継がれます。
      </p>
      <Button href={href} variant="primary" size="sm" className="mt-4 font-acumin">
        会員登録へ進む
      </Button>
    </section>
  );
}
