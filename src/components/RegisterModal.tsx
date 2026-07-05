"use client";

import React, { useState } from "react";
import Link from "next/link";
import Script from "next/script";
import { useLogin } from "@/contexts/LoginContext";
import { Button } from "@/components/ui/Button/Button";
import { TextField } from "@/components/ui/TextField/TextField";
import { useTurnstileWidget } from "@/hooks/useTurnstileWidget";

const xsTextStyle: React.CSSProperties = { fontSize: "var(--lk-size-xs)" };
const mdTextStyle: React.CSSProperties = { fontSize: "var(--lk-size-md)" };

interface RegisterModalProps {
  onSwitchToLogin?: () => void;
}

const RegisterModal: React.FC<RegisterModalProps> = ({ onSwitchToLogin }) => {
  const { register, loginWithGoogle } = useLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentMessage, setSentMessage] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string>("");
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "";
  const { containerRef: turnstileRef, renderWidget: renderTurnstile } =
    useTurnstileWidget(siteKey, setTurnstileToken);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("パスワードは8文字以上で入力してください");
      return;
    }
    if (password !== confirmPassword) {
      setError("パスワードが一致しません");
      return;
    }
    if (siteKey && !turnstileToken) {
      setError("ボット検証を完了してください");
      return;
    }

    setLoading(true);
    try {
      const res = await register(email, password, turnstileToken || undefined);
      if (!res.success) {
        setError(res.error || "登録に失敗しました");
      } else {
        setSentMessage(
          res.message ||
            "確認メールを送信しました。メールのリンクから登録を完了してください。",
        );
      }
    } catch (err) {
      console.error("Unexpected register error", err);
      setError("登録に失敗しました");
    } finally {
      setLoading(false);
    }
  };

  if (sentMessage) {
    return (
      <div className="w-full max-w-md mx-auto px-6 text-center">
        <p
          role="status"
          className="mb-6 flex items-center justify-center gap-2"
          style={mdTextStyle}
        >
          <span aria-hidden="true">✓</span>
          {sentMessage}
        </p>
        <p className="mb-8 text-[#474747]" style={xsTextStyle}>
          メールが届かない場合は、迷惑メールフォルダをご確認ください。
        </p>
        {onSwitchToLogin ? (
          <button
            type="button"
            onClick={onSwitchToLogin}
            className="underline underline-offset-4 hover:text-black transition-colors"
            style={mdTextStyle}
          >
            ログインページへ
          </button>
        ) : (
          <Link
            href="/login"
            className="underline underline-offset-4 hover:text-black transition-colors"
            style={mdTextStyle}
          >
            ログインページへ
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="w-full max-w-md mx-auto px-6">
      {siteKey ? (
        <Script
          id="turnstile-register-script"
          src="https://challenges.cloudflare.com/turnstile/v0/api.js"
          strategy="afterInteractive"
          onReady={renderTurnstile}
        />
      ) : null}
      <Button
        type="button"
        onClick={() => {
          void loginWithGoogle({ next: "/auth/verified" });
        }}
        variant="secondary"
        size="xl"
        shape="rounded"
        className="w-full flex items-center justify-center gap-3 mb-4 sm:mb-8"
        style={{ minHeight: "3rem" }}
      >
        <i className="ri-google-fill text-lg"></i>Googleで登録
      </Button>
      <div className="relative mb-4 sm:mb-8">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-black/20"></div>
        </div>
        <div className="relative flex justify-center">
          <span className="px-4 bg-white text-[#474747]" style={mdTextStyle}>
            OR
          </span>
        </div>
      </div>
      <form
        className="space-y-4 sm:space-y-6 mb-6 sm:mb-8"
        onSubmit={handleRegister}
      >
        <TextField
          id="email"
          label="EMAIL"
          type="email"
          shape="rounded"
          size="lg"
          className="min-h-[2.5rem] sm:min-h-[2.75rem]"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextField
          id="password"
          label="PASSWORD"
          type="password"
          shape="rounded"
          size="lg"
          className="min-h-[2.5rem] sm:min-h-[2.75rem]"
          required
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <TextField
          id="confirm-password"
          label="PASSWORD（確認）"
          type="password"
          shape="rounded"
          size="lg"
          className="min-h-[2.5rem] sm:min-h-[2.75rem]"
          required
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
        />
        {siteKey ? (
          <div className="pt-2">
            <div ref={turnstileRef}></div>
          </div>
        ) : null}
        <Button
          type="submit"
          size="xl"
          shape="rounded"
          className="w-full"
          style={{ minHeight: "3rem" }}
          disabled={loading || !email || !password || !confirmPassword}
        >
          {loading ? "処理中..." : "登録して確認メールを受け取る"}
        </Button>
        {error ? (
          <p role="alert" className="text-red-600 mt-2" style={mdTextStyle}>
            {error}
          </p>
        ) : null}
      </form>
      {onSwitchToLogin ? (
        <>
          <hr className="mb-4 sm:mb-8 border-black/20" />
          <p
            className="text-center mb-4 sm:mb-12 text-[#474747]"
            style={mdTextStyle}
          >
            <button
              type="button"
              onClick={onSwitchToLogin}
              className="ml-1 underline underline-offset-4 hover:text-black transition-colors"
            >
              既にアカウントをお持ちの方はこちら
            </button>
          </p>
        </>
      ) : null}
    </div>
  );
};

export default RegisterModal;
