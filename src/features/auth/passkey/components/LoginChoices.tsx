/**
 * ログイン画面の3つの入口（パスキー・Google・メールのコード）（src/features/auth/passkey/components/LoginChoices.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-325
 * @design DD-AUTH-063
 * @remarks パスキーに未対応のブラウザかどうかは描画後（`useEffect`）に判定し、サーバーの描画と食い違わせない。
 * 始めの方式（`server` / `browser`）は `resolveBrowserStartMode()` で読み、`browser` の時だけ Turnstile のトークンを渡して GoTrue を直に呼ぶ（判断13）。
 * Turnstile の枠は1つで、パスキー（`browser` の時）とメールで共有する。送るたびに引き直す（ADR-0411）。
 * パスキーのログインでは、パスキーを作る勧めの画面を出さない（すでに持っている）。
 * `challenge_id`・`credential`・トークンは画面にもログにも出さない。
 */
"use client";

import React, { useEffect, useState } from "react";
import Script from "next/script";
import { useRouter } from "next/navigation";
import { useLogin } from "@/contexts/LoginContext";
import { supabase } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button/Button";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import { useTurnstileWidget } from "@/hooks/useTurnstileWidget";
import { createPasskeyAuthenticationStarter, resolveBrowserStartMode } from "@/features/auth/passkey/browser-start";
import { loginWithPasskey, type LoginFailureReason } from "@/features/auth/passkey/passkey-client";
import { requestAssertion, isPasskeySupported } from "@/features/auth/passkey/webauthn-browser";
import { resolvePostLoginPath } from "@/features/auth/passkey/post-login";
import EmailCodeStartForm from "@/features/auth/passkey/components/EmailCodeStartForm";
import "@/components/AuthForm.css";

const MSG_UNSUPPORTED = "この端末ではパスキーを使えません。メールのコードか Google でログインできます。";
const MSG_UNAVAILABLE = "ただいまパスキーを使えません。メールのコードか Google でログインしてください。";

function passkeyMessage(reason: LoginFailureReason, retryAfterSeconds?: number): string {
  switch (reason) {
    case "cancelled":
      return "パスキーでのログインを中止しました。";
    case "not_found":
      return "このパスキーではログインできませんでした。メールのコードか Google でもログインできます。";
    case "uv_required":
      return "この端末で本人確認をしてから、もう一度お試しください。";
    case "staff_blocked":
      return "このパスキーはログインに使えません。";
    case "rate_limited": {
      const base = "ログインの試行が集中しています。しばらくしてからお試しください。";
      if (retryAfterSeconds === undefined) return base;
      return `${base}（約 ${Math.max(1, Math.ceil(retryAfterSeconds / 60))} 分後）`;
    }
    default:
      return MSG_UNAVAILABLE;
  }
}

function OrDivider() {
  return (
    <div className="relative my-4 sm:my-6">
      <div className="absolute inset-0 flex items-center">
        <div className="w-full border-t border-black/20"></div>
      </div>
      <div className="relative flex justify-center">
        <span className="px-4 bg-white lk-text-xs text-[#474747] tracking-widest">OR</span>
      </div>
    </div>
  );
}

type Props = {
  returnTo?: string;
  initialEmail?: string;
  /** 確認のメールのリンクを別のブラウザで開いた人への固定の案内 */
  notice?: string;
  /** 店員が Google・メールのコードで入ろうとした時の固定の文（呼び手が決めた文だけを渡す） */
  errorMessage?: string;
};

export default function LoginChoices({ returnTo, initialEmail, notice, errorMessage }: Props) {
  const router = useRouter();
  const { loginWithGoogle, refreshAuthState } = useLogin();
  // サーバーの描画と同じ値で始め、描画後に未対応なら外す。
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refocus, setRefocus] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState("");
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "";
  const {
    containerRef: turnstileRef,
    renderWidget: renderTurnstile,
    resetWidget: resetTurnstile,
  } = useTurnstileWidget(siteKey, setTurnstileToken);

  useEffect(() => {
    setSupported(isPasskeySupported());
  }, []);

  // 無効になったボタンからフォーカスが落ちるので、失敗の後、ボタンが戻ってからフォーカスが失われていれば戻す（ほかへ移していたら奪わない）。
  useEffect(() => {
    if (!refocus || busy) return;
    // 効果は部品が置かれている間だけ走るので、要素は必ずある。
    if (document.activeElement === document.body) document.getElementById("passkey-login")!.focus();
    setRefocus(false);
  }, [refocus, busy]);

  const handlePasskey = async () => {
    setBusy(true);
    setPasskeyError(null);
    setCancelled(null);
    try {
      const mode = resolveBrowserStartMode();
      const start = createPasskeyAuthenticationStarter({
        mode,
        ...(mode === "browser" ? { supabase } : {}),
      });
      const result = await loginWithPasskey({
        start,
        assert: requestAssertion,
        ...(returnTo ? { next: returnTo } : {}),
        ...(mode === "browser" && turnstileToken ? { captchaToken: turnstileToken } : {}),
      });
      if (mode === "browser") resetTurnstile();

      if (result.ok) {
        // 移動が終わるまでボタンを止めたままにする。
        await refreshAuthState();
        router.replace(await resolvePostLoginPath());
        return;
      }
      const message = passkeyMessage(result.reason, result.retryAfterSeconds);
      if (result.reason === "cancelled") setCancelled(message);
      else setPasskeyError(message);
    } catch {
      setPasskeyError(MSG_UNAVAILABLE);
    }
    setBusy(false);
    setRefocus(true);
  };

  return (
    <div className="w-full max-w-md mx-auto px-6">
      {siteKey ? (
        <Script
          id="turnstile-login-script"
          src="https://challenges.cloudflare.com/turnstile/v0/api.js"
          strategy="afterInteractive"
          onReady={renderTurnstile}
        />
      ) : null}
      <h1 className="sr-only">ログイン</h1>
      {notice ? (
        <p role="status" className="pb-[13px] lk-text-md text-[#474747]">
          {notice}
        </p>
      ) : null}

      {errorMessage ? (
        <p role="alert" className="pb-[13px] lk-text-md text-red-600">
          {errorMessage}
        </p>
      ) : null}

      {supported ? (
        <div>
          <Button
            type="button"
            size="md"
            className="auth-action w-full"
            id="passkey-login"
            disabled={busy}
            aria-busy={busy}
            onClick={handlePasskey}
          >
            <i className="ri-fingerprint-line lk-text-2xl" aria-hidden="true"></i>
            {busy ? "確認しています…" : "パスキーでログイン"}
          </Button>
          <p className="mt-2 lk-text-xs text-center text-[#474747]">この端末の顔認証・指紋・PIN で入れます。</p>
        </div>
      ) : (
        <p className="lk-text-sm text-center text-[#474747]">{MSG_UNSUPPORTED}</p>
      )}
      <LiveMessage className="mt-2 lk-text-sm text-red-600">{passkeyError}</LiveMessage>
      <LiveMessage politeness="status" className="mt-2 lk-text-sm">
        {cancelled}
      </LiveMessage>

      <OrDivider />

      <div data-auth-alternate role="group" aria-label="その他のログイン方法">
        <Button
          type="button"
          onClick={() => {
            void loginWithGoogle({ next: returnTo });
          }}
          variant="outline"
          size="md"
          className="auth-action w-full"
        >
          <i className="ri-google-fill lk-text-2xl" aria-hidden="true"></i>
          Googleでサインイン
        </Button>
      </div>

      <OrDivider />

      <EmailCodeStartForm
        initialEmail={initialEmail}
        returnTo={returnTo}
        siteKey={siteKey}
        turnstileToken={turnstileToken}
        turnstileRef={turnstileRef}
        resetTurnstile={resetTurnstile}
      />
    </div>
  );
}
