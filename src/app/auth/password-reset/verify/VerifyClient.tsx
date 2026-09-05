"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/Button/Button";
import "@/components/AuthForm.css";

type Props = {
  token: string;
};

/**
 * リンクの確認を到達時に自動で済ませ、新しいパスワードの入力へ送る。
 *
 * 以前はここに「パスワードを再設定する」ボタンを置いていた。トークンを開いた時点で
 * 消費していたため、リンクスキャナの GET から守るのにワンクリックが要ったため。
 * 消費を confirm（実際にパスワードを変えたとき）へ移したので、この POST に副作用は無く、
 * 画面を挟む理由も無くなった。
 */
export default function VerifyClient({ token }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  // 送信済みかを ref で持つ。トークンは 1 回しか通らないので、再レンダーや
  // 開発時の Effect 二重実行で 2 回投げると、2 回目が使用済み扱いになり、
  // 正しいリンクなのに期限切れとして弾かれる。
  const sentRef = useRef(false);

  const verify = useCallback(async () => {
    setError(null);

    try {
      const resp = await fetch("/api/auth/password-reset/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });

      if (!resp.ok) {
        router.replace("/auth/password-reset?error=link_expired");
        return;
      }

      router.replace("/auth/password-reset");
    } catch (err) {
      console.error(err);
      // 通信で落ちたときだけ手動の再試行を出す。自動送信しかないと、
      // 一時的な失敗で利用者に打つ手が無くなる。
      sentRef.current = false;
      setError("リンクの確認に失敗しました。時間をおいて再度お試しください。");
    }
  }, [router, token]);

  useEffect(() => {
    if (sentRef.current) return;
    sentRef.current = true;
    void verify();
  }, [verify]);

  const handleRetry = () => {
    sentRef.current = true;
    void verify();
  };

  return (
    <div className="w-full max-w-md mx-auto">
      <div className="px-6 text-center">
        <h1 className="mb-[21px] font-brand lk-text-lg tracking-widest sm:mb-[34px]">
          パスワード再設定
        </h1>
        {error ? (
          <>
            <p
              role="alert"
              className="lk-text-sm text-red-600 whitespace-pre-line"
            >
              {error}
            </p>
            <Button
              type="button"
              className="auth-action w-full mt-6"
              size="md"
              onClick={handleRetry}
            >
              もう一度試す
            </Button>
            <Link
              href="/login"
              className="mt-6 inline-block lk-text-xs underline underline-offset-4 hover:text-[#474747] transition-colors"
            >
              ログインへ
            </Link>
          </>
        ) : (
          <p role="status" className="lk-text-sm">
            確認中...
          </p>
        )}
      </div>
    </div>
  );
}
