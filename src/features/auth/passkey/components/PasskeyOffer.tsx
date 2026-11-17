/**
 * メールのコードでログインした直後の「パスキーを作りませんか」の勧め（src/features/auth/passkey/components/PasskeyOffer.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-328
 * @design DD-AUTH-064
 * @remarks ログインしていない人は `/login` へ、店員と、顔・指紋・PIN の使えない端末の人には勧めを出さずに行き先へ送る（出す前に判定し、判定が終わるまで何も描かない）。
 * 成功しても自動では進まない（読む時間を奪わない。WCAG 2.2.1）。「続ける」のボタンへフォーカスを移す。
 * 勧めの画面は post-login を呼ぶ前に出す（戻り先を使い切らない）。「あとで」・成功後・先へ進むボタンが、初めて `resolvePostLoginPath()` を呼ぶ。
 * フォーカスは、無効になったボタンから落ちた時だけ戻す（ほかへ移していたら奪わない）。
 * `challenge_id`・`credential`・トークンは画面にもログにも出さない（`registerPasskey` が持つ）。
 */
"use client";

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLogin } from "@/contexts/LoginContext";
import { Button } from "@/components/ui/Button/Button";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import { clientFetch } from "@/lib/client-fetch";
import { registerPasskey, type RegisterFailureReason } from "@/features/auth/passkey/passkey-client";
import { requestAttestation } from "@/features/auth/passkey/webauthn-browser";
import { deviceNameFromUserAgent } from "@/features/auth/passkey/device-name";
import { resolvePostLoginPath } from "@/features/auth/passkey/post-login";
import "@/components/AuthForm.css";

const MSG_CREATED = "パスキーを作りました。";
const MSG_NAME_NOT_APPLIED = "名前は、アカウントのログイン方法から変えられます。";

function failureMessage(reason: RegisterFailureReason): string {
  switch (reason) {
    case "cancelled":
      return "パスキーの作成を中止しました。";
    case "already_registered":
      return "この端末のパスキーは、すでにアカウントに登録されています。";
    case "unsupported":
      return "この端末ではパスキーを作れません。";
    case "reauth_required":
    case "unauthorized":
      return "もう一度ログインしてください。";
    case "rate_limited":
      return "試行が集中しています。しばらくしてからやり直してください。";
    case "unavailable":
      return "ただいまパスキーを作れません。時間をおいてお試しください。";
    default:
      return "うまく作れませんでした。もう一度お試しください。";
  }
}

/** 顔・指紋・PIN の使える端末かどうか。確かめられない時は勧めない側に倒す。 */
async function canVerifyOnDevice(): Promise<boolean> {
  try {
    return (
      typeof window.PublicKeyCredential !== "undefined" &&
      (await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())
    );
  } catch {
    return false;
  }
}

export default function PasskeyOffer() {
  const router = useRouter();
  const { isAuthResolved, isLoggedIn, userRole } = useLogin();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const leavingRef = useRef(false);
  const checkedRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ nameApplied: boolean } | null>(null);
  const [failure, setFailure] = useState<RegisterFailureReason | null>(null);
  const [refocus, setRefocus] = useState(false);

  const leave = async () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    router.replace(await resolvePostLoginPath());
  };

  useEffect(() => {
    if (!isAuthResolved || checkedRef.current) return;
    checkedRef.current = true;
    if (!isLoggedIn) {
      router.replace("/login");
      return;
    }
    if (userRole !== "user") {
      void leave();
      return;
    }
    void canVerifyOnDevice().then((available) => {
      if (available) setReady(true);
      else void leave();
    });
    // 判定は一度だけ。`leave` は ref だけを読む。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthResolved, isLoggedIn, userRole]);

  // 勧めを出した時に、見出しへ移す。
  useEffect(() => {
    if (ready) headingRef.current!.focus();
  }, [ready]);

  // 無効になったボタンからフォーカスが落ちるので、ボタンが戻ってから落ちたままなら、主のボタンへ戻す（ほかへ移していたら奪わない）。
  useEffect(() => {
    if (!refocus || busy) return;
    if (document.activeElement === document.body) {
      const target = document.getElementById("passkey-offer-create") ?? document.getElementById("passkey-offer-continue");
      target!.focus();
    }
    setRefocus(false);
  }, [refocus, busy]);

  // 成功した時は、読み上げと操作の起点を「続ける」へ移す。
  useEffect(() => {
    if (created) document.getElementById("passkey-offer-continue")!.focus();
  }, [created]);

  const handleCreate = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await registerPasskey({
        fetchApi: clientFetch,
        create: requestAttestation,
        deviceName: deviceNameFromUserAgent(navigator.userAgent),
      });
      if (result.ok) {
        setCreated({ nameApplied: result.nameApplied });
      } else {
        setFailure(result.reason);
        setRefocus(true);
      }
    } catch {
      setFailure("failed");
      setRefocus(true);
    }
    setBusy(false);
  };

  if (!ready) return null;

  const leaveOnly = failure === "already_registered" || failure === "unsupported";
  const mustLogin = failure === "reauth_required" || failure === "unauthorized";
  const retry = failure === "retry" || failure === "failed";

  return (
    <div className="w-full max-w-md mx-auto px-6">
      <h1 ref={headingRef} tabIndex={-1} className="font-brand lk-text-4xl tracking-widest text-center outline-none">
        パスキーを作りませんか
      </h1>
      <p className="mt-5 lk-text-sm leading-relaxed">
        次回からは、この端末の顔認証・指紋・PIN でログインできます。メールでコードを待つ必要はありません。
      </p>
      <p className="mt-2 lk-text-xs leading-relaxed text-[#474747]">あとからでも、アカウントの「ログイン方法」で作れます。</p>

      <LiveMessage className="mt-4 lk-text-sm text-red-600">{failure ? failureMessage(failure) : null}</LiveMessage>
      <LiveMessage politeness="status" className="mt-4 lk-text-sm">
        {created ? (created.nameApplied ? MSG_CREATED : `${MSG_CREATED}${MSG_NAME_NOT_APPLIED}`) : null}
      </LiveMessage>

      <div className="mt-6 flex flex-col gap-3">
        {created || leaveOnly ? (
          <Button type="button" size="md" className="auth-action w-full" id="passkey-offer-continue" onClick={() => void leave()}>
            続ける
          </Button>
        ) : mustLogin ? (
          <Button type="button" size="md" className="auth-action w-full" id="passkey-offer-continue" onClick={() => router.replace("/login")}>
            ログインへ
          </Button>
        ) : (
          <>
            <Button
              type="button"
              size="md"
              className="auth-action w-full"
              id="passkey-offer-create"
              disabled={busy}
              aria-busy={busy}
              onClick={() => void handleCreate()}
            >
              {busy ? "作成しています…" : retry ? "もう一度" : "パスキーを作る"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="md"
              className="auth-action w-full"
              id="passkey-offer-later"
              disabled={busy}
              onClick={() => void leave()}
            >
              あとで
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
