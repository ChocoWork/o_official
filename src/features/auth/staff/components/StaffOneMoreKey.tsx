/**
 * 認めた鍵が1本の店員の「もう1本」の画面（src/features/auth/staff/components/StaffOneMoreKey.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-386
 * @design DD-AUTH-082
 * @remarks `/admin/passkeys?more=1` が、認めた鍵が1本の店員に出す。鍵の登録は段2の `registerPasskey` を使い、
 * 窓口の `reauth_required`（店員の追加は5分以内のパスキーでの入り直しが要る）を「もう一度パスキーでログインしてから追加してください。」と
 * 「パスキーでログインし直す」に読み替える。登録できたらログインの印（認めた鍵の本数の印を含む）を更新してから `/admin` へ移る。
 * 更新できなければ移らず、入り直しをすすめる（古い印のまま入れないため）。`challenge_id`・`credential`・トークンは画面にもログにも出さない。
 */
"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button/Button";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import { useLogin } from "@/contexts/LoginContext";
import { clientFetch, refreshSessionOnce } from "@/lib/client-fetch";
import { registerPasskey, type RegisterFailureReason } from "@/features/auth/passkey/passkey-client";
import { isPasskeySupported, requestAttestation } from "@/features/auth/passkey/webauthn-browser";
import { deviceNameFromUserAgent } from "@/features/auth/passkey/device-name";
import { buildLoginHref } from "@/features/auth/return-intent/use-login-href";
import "@/components/AuthForm.css";

const REAUTH_HREF = buildLoginHref("/admin/passkeys", "http://localhost");
const MSG_UNSUPPORTED = "この端末ではパスキーを登録できません。別の端末か、セキュリティキーでお試しください。";
const MSG_REAUTH = "もう一度パスキーでログインしてから追加してください。";
const MSG_ADDED_RELOGIN = "登録できました。もう一度パスキーでログインしてください。";

function failureMessage(reason: RegisterFailureReason): string {
  switch (reason) {
    case "cancelled":
      return "登録を中止しました。もう一度お試しください。";
    case "already_registered":
      return "この端末のパスキーは、すでに登録されています。別の端末か、セキュリティキーで登録してください。";
    case "unsupported":
      return MSG_UNSUPPORTED;
    case "reauth_required":
      return MSG_REAUTH;
    case "unauthorized":
      return "もう一度ログインしてください。";
    case "rate_limited":
      return "試行が集中しています。しばらくしてからやり直してください。";
    case "unavailable":
      return "ただいま登録できません。時間をおいてお試しください。";
    default:
      return "うまく登録できませんでした。もう一度お試しください。";
  }
}

export default function StaffOneMoreKey() {
  const router = useRouter();
  const { refreshAuthState } = useLogin();
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<RegisterFailureReason | null>(null);
  const [needsRelogin, setNeedsRelogin] = useState(false);
  const [refocus, setRefocus] = useState(false);

  useEffect(() => {
    setSupported(isPasskeySupported());
  }, []);

  // 追加の間は無効になって、フォーカスが落ちる。落ちたままなら主のボタンへ戻す（ほかへ移していたら奪わない）。
  useEffect(() => {
    if (!refocus || busy) return;
    if (document.activeElement === document.body) document.getElementById("staff-one-more-primary")?.focus();
    setRefocus(false);
  }, [refocus, busy]);

  const addKey = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await registerPasskey({
        fetchApi: clientFetch,
        create: requestAttestation,
        deviceName: deviceNameFromUserAgent(navigator.userAgent),
      });
      if (result.ok) {
        if ((await refreshSessionOnce()) === "refreshed") {
          await refreshAuthState();
          router.replace("/admin");
          return;
        }
        setNeedsRelogin(true);
      } else {
        setFailure(result.reason);
      }
    } catch {
      setFailure("failed");
    }
    setBusy(false);
    setRefocus(true);
  };

  return (
    <div className="flex min-h-[calc(100dvh-6.5rem)] w-full flex-col items-center justify-center px-6 py-16 text-center">
      <div className="w-full max-w-md space-y-6 text-left">
        <h1 id="staff-one-more-heading" tabIndex={-1} className="text-center outline-none" style={{ fontSize: "var(--lk-size-3xl)" }}>
          あと1本、登録してください
        </h1>
        <p style={{ fontSize: "var(--lk-size-lg)" }}>
          管理画面に入るには、パスキー（顔認証・指紋・PIN で入る方法）が2本必要です。いまは1本だけ登録されています。
        </p>
        <p className="text-[#474747]" style={{ fontSize: "var(--lk-size-md)" }}>
          別の端末か、セキュリティキーでの登録をおすすめします。
        </p>

        {needsRelogin ? (
          <div className="flex flex-col items-start gap-3">
            <p role="status" style={{ fontSize: "var(--lk-size-md)" }}>
              {MSG_ADDED_RELOGIN}
            </p>
            <Button href="/login" variant="primary" size="md">
              ログインへ
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-start gap-3">
            <Button
              type="button"
              id="staff-one-more-primary"
              size="md"
              disabled={busy || !supported}
              aria-busy={busy}
              onClick={() => void addKey()}
            >
              {busy ? "登録しています…" : "2本目を登録"}
            </Button>
            {!supported ? (
              <p className="text-[#474747]" style={{ fontSize: "var(--lk-size-sm)" }}>
                {MSG_UNSUPPORTED}
              </p>
            ) : null}
            <LiveMessage className="text-red-600" style={{ fontSize: "var(--lk-size-md)" }}>
              {failure ? failureMessage(failure) : null}
            </LiveMessage>
            {failure === "reauth_required" ? (
              <Button href={REAUTH_HREF} variant="primary" size="md">
                パスキーでログインし直す
              </Button>
            ) : null}
            {failure === "unauthorized" ? (
              <Button href="/login" variant="primary" size="md">
                ログインへ
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
