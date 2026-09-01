"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/Button/Button";
import "@/components/AuthForm.css";

type Props = {
  token: string;
};

export default function VerifyClient({ token }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleVerify = async () => {
    setError(null);
    setLoading(true);

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
      setError("リンクの確認に失敗しました。時間をおいて再度お試しください。");
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-md mx-auto px-4 sm:px-6 pt-2">
      <div className="px-6 pt-6 sm:pt-10 lg:pt-13.75">
        <h1 className="mb-[21px] text-center font-brand lk-text-lg tracking-widest sm:mb-[34px]">
          パスワード再設定
        </h1>
        <p className="lk-text-sm mb-6 text-center">
          下のボタンを押すと、新しいパスワードの入力に進みます。
        </p>
        <Button
          type="button"
          className="auth-action w-full"
          size="md"
          disabled={loading}
          onClick={handleVerify}
        >
          {loading ? "確認中..." : "パスワードを再設定する"}
        </Button>
        {error ? (
          <p role="alert" className="lk-text-sm text-red-600 mt-4 whitespace-pre-line">
            {error}
          </p>
        ) : null}
        <Link
          href="/login"
          className="mt-4 inline-block lk-text-xs underline underline-offset-4 hover:text-[#474747] transition-colors"
        >
          ログインへ
        </Link>
      </div>
    </div>
  );
}
