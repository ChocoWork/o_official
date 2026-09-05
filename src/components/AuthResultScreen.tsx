import React from "react";
import "./AuthResultScreen.css";

type AuthResultScreenProps = {
  /** 何の結果かを一目で示す図。文字より先に読める要素として最上段に置く。 */
  icon: React.ReactNode;
  /** 何が起きたか。この画面で最も強い要素にする。 */
  title: string;
  /** 宛先や次にすることなど、title を補う情報。 */
  detail?: React.ReactNode;
  /** うまくいかなかったときのための注意書き。面で沈めて本題と分ける。 */
  note?: React.ReactNode;
  /** そのモードで唯一やるべきこと。主ボタン相当の重みで置く。 */
  action?: React.ReactNode;
  /** 主ではない逃げ道。従の重みで置く。 */
  links?: React.ReactNode;
};

/**
 * 図の右下に重ねる完了バッジ。どのアイコンでも同じ位置・同じ形にして、
 * 「結果画面の印」として繰り返す。白い縁は図の線と円が接したときの分離用。
 */
function CompletionBadge() {
  return (
    <>
      <circle cx="45" cy="32" r="11.5" fill="#ffffff" />
      <circle cx="45" cy="32" r="9" fill="currentColor" />
      <path
        d="M40.8 32.1 L43.6 34.9 L49.2 28.6"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  );
}

/** メールを送った結果の図。封筒＋完了バッジ。 */
export function MailSentIcon() {
  return (
    <svg
      viewBox="0 0 56 44"
      className="h-11 w-14"
      data-testid="auth-result-icon-mail"
      aria-hidden="true"
      focusable="false"
    >
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
        <rect x="1.8" y="5.8" width="43" height="31" />
        <path d="M1.8 5.8 L23.3 21.5 L44.8 5.8" />
      </g>
      <CompletionBadge />
    </svg>
  );
}

/** パスワードを更新した結果の図。南京錠＋完了バッジ。 */
export function PasswordUpdatedIcon() {
  return (
    <svg
      viewBox="0 0 56 44"
      className="h-11 w-14"
      data-testid="auth-result-icon-password"
      aria-hidden="true"
      focusable="false"
    >
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
        <rect x="11.8" y="18.8" width="27" height="18" />
        <path d="M17.3 18.8 V13.5 a8 8 0 0 1 16 0 V18.8" />
      </g>
      <CompletionBadge />
    </svg>
  );
}

/**
 * 認証フローで「この画面ですることは終わった」状態を出す共通画面。
 *
 * フォームを畳んで結果だけ残す。フォームが残っていると完了したのか分からず、
 * 同じボタンをもう一度押してレート制限に当たる（送信は 1 時間 5 回まで）。
 * 各スロットの意味と重みを固定して、モードが違っても同じ形で読めるようにする。
 *
 * title はこの画面の見出しそのものなので h1 で出す。呼び出し側はページの
 * 見出しを畳み、結果を画面で最も強い要素にすること。
 */
export function AuthResultScreen({
  icon,
  title,
  detail,
  note,
  action,
  links,
}: AuthResultScreenProps) {
  return (
    <div className="text-center">
      {/* カウントダウンは毎秒変わるので status の外に置く。中に入れると読み上げが毎秒走る。 */}
      <div role="status">
        {/* 近接の 4 段階。狭い順に
              (1) タイトル→詳細 5px … 一続きの文
              (2) 図→タイトル 7.5px … 同じまとまりだが種類が違う
              (3) 詳細→注意書き 20px … まとまりの境目
              (4) 注意書き→主アクション→補助リンク 30px … 別の役割
            各段は 1 つ上を黄金比（--phi 1.618）で割った値。 */}
        <div className="flex flex-col items-center gap-[7.5px]">
          {icon}
          {/* h1 はグローバル指定で Didot（セリフ）になる。認証画面の見出しは
              ページ見出しと同じサンセリフに戻す。 */}
          <h1 className="font-brand auth-result-title tracking-widest">{title}</h1>
        </div>
        {detail ? (
          <div className="mt-[5px] lk-text-sm leading-relaxed">{detail}</div>
        ) : null}
      </div>
      {note ? (
        <div
          data-testid="auth-result-note"
          className="mt-5 flex items-start gap-3 bg-[#ededed] px-5 py-4 text-left lk-text-xs leading-relaxed text-[#474747]"
        >
          <i
            className="ri-information-line shrink-0 lk-text-sm leading-relaxed"
            aria-hidden="true"
          ></i>
          <div>{note}</div>
        </div>
      ) : null}
      {/* 主アクションの上下は同じ 30px。ここだけ狭いと、主アクションが
          補助リンク側のまとまりに見える。 */}
      {action ? <div className="mt-[30px]">{action}</div> : null}
      {links ? (
        <div className="mt-[30px] flex items-center justify-center gap-6">
          {links}
        </div>
      ) : null}
    </div>
  );
}
