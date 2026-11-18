/**
 * 店員の2本の登録の画面（src/features/auth/staff/components/StaffRegisterScreen.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-375
 * @design DD-AUTH-080
 * @remarks 「1本目」「2本目」の2段。鍵の登録は段2の `registerPasskey` を使い、窓の内か外かは窓口の返事（`window_closed`・`reauth_required`）で決める
 * （画面は進み具合の表示のために数えるだけで、判断には使わない。本数は最初にサーバーが渡す）。2本目の前に、別の端末かセキュリティキーをすすめる。
 * 2本そろったら自動で `completeStaffRegistration` を呼び、成功したら完了の文と「ログインへ」を出す（自動では進まない。読む時間を奪わない。WCAG 2.2.1）。
 * 完了の窓口が全ログインを終わらせるので、画面からログインの状態は作らない。`challenge_id`・`credential`・トークンは画面にもログにも出さない（`registerPasskey` が持つ）。
 */
"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button/Button";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import { clientFetch } from "@/lib/client-fetch";
import { registerPasskey, type RegisterFailureReason } from "@/features/auth/passkey/passkey-client";
import { requestAttestation } from "@/features/auth/passkey/webauthn-browser";
import { deviceNameFromUserAgent } from "@/features/auth/passkey/device-name";
import { completeStaffRegistration, type CompleteFailureReason } from "@/features/auth/staff/staff-register-client";
import "@/components/AuthForm.css";

const MSG_ADVICE = "別の端末か、セキュリティキーでの登録をおすすめします。";
const MSG_KEYS_SHORT = "あと1本、登録してください。";
const MSG_DONE = "登録が終わりました。パスキーでログインしてください。";
const MSG_CLOSED = "時間が過ぎました。店長に、もう一度招待を出してもらってください。";
const MSG_REINVITE = "店長に、もう一度招待を出してもらってください。";
const MSG_RATE = "試行が集中しています。しばらくしてからやり直してください。";
const MSG_REGISTER_FAILED = "うまく登録できませんでした。もう一度お試しください。";

function registerMessage(reason: RegisterFailureReason): string {
  switch (reason) {
    case "cancelled":
      return "登録を中止しました。もう一度お試しください。";
    case "already_registered":
      return "この端末のパスキーは、すでに登録されています。別の端末か、セキュリティキーで登録してください。";
    case "unsupported":
      return "この端末ではパスキーを登録できません。別の端末か、セキュリティキーでお試しください。";
    case "rate_limited":
      return MSG_RATE;
    case "unavailable":
      return "ただいま登録できません。時間をおいてお試しください。";
    default:
      return MSG_REGISTER_FAILED;
  }
}

function completeMessage(reason: CompleteFailureReason): string {
  switch (reason) {
    case "keys_short":
      return MSG_KEYS_SHORT;
    case "keys_not_window":
      return MSG_REINVITE;
    case "rate_limited":
      return MSG_RATE;
    case "unavailable":
      return "ただいま完了できません。時間をおいてお試しください。";
    default:
      return "うまく完了できませんでした。もう一度お試しください。";
  }
}

export default function StaffRegisterScreen({ initialRegistered }: { initialRegistered: number }) {
  const router = useRouter();
  const [registered, setRegistered] = useState(Math.min(Math.max(initialRegistered, 0), 2));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const [completable, setCompletable] = useState(initialRegistered >= 1);
  const [done, setDone] = useState<string | null>(null);

  // 段が変わるとボタンが入れ替わり、フォーカスが落ちる。落ちたままなら主のボタンへ戻す（ほかへ移していたら奪わない）。
  useEffect(() => {
    if (document.activeElement !== document.body) return;
    document.getElementById("staff-register-primary")?.focus();
  }, [registered, done]);

  const finish = async () => {
    const result = await completeStaffRegistration(clientFetch);
    if (result.ok) {
      setDone(result.redirectTo);
    } else if (result.reason === "window_closed") {
      setClosed(true);
    } else {
      setNotice(completeMessage(result.reason));
    }
  };

  const addKey = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await registerPasskey({
        fetchApi: clientFetch,
        create: requestAttestation,
        deviceName: deviceNameFromUserAgent(navigator.userAgent),
      });
      if (result.ok) {
        const next = registered + 1;
        setRegistered(next);
        setCompletable(true);
        if (next >= 2) await finish();
      } else if (result.reason === "window_closed" || result.reason === "unauthorized") {
        setClosed(true);
      } else if (result.reason === "reauth_required") {
        // 窓の免除は最初の2本まで。窓口が「もう超えている」と答えたので、完了へ進む。
        setCompletable(true);
        await finish();
      } else {
        setNotice(registerMessage(result.reason));
      }
    } catch {
      setNotice(MSG_REGISTER_FAILED);
    }
    setBusy(false);
  };

  const complete = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await finish();
    } catch {
      setNotice(completeMessage("failed"));
    }
    setBusy(false);
  };

  const steps = [
    { label: "1本目", registered: registered >= 1 },
    { label: "2本目", registered: registered >= 2 },
  ];

  return (
    <div className="w-full max-w-md mx-auto px-6">
      <h1 tabIndex={-1} className="font-brand lk-text-4xl tracking-widest text-center outline-none">
        パスキーを2本登録してください
      </h1>
      <p className="mt-5 lk-text-sm leading-relaxed">
        顔認証・指紋・PIN で入る方法（パスキー）を、2本登録します。
      </p>

      <ol className="mt-4 lk-text-sm flex flex-col gap-1" aria-label="登録の進み具合">
        {steps.map((step) => (
          <li key={step.label}>
            {step.label}
            {step.registered ? "：登録しました" : ""}
          </li>
        ))}
      </ol>

      <LiveMessage className="mt-4 lk-text-sm text-red-600">{closed ? MSG_CLOSED : notice}</LiveMessage>
      <LiveMessage politeness="status" className="mt-4 lk-text-sm">
        {done ? MSG_DONE : null}
      </LiveMessage>

      <div className="mt-6 flex flex-col gap-3">
        {done ? (
          <Button
            type="button"
            size="md"
            className="auth-action w-full"
            id="staff-register-primary"
            onClick={() => router.replace(done)}
          >
            ログインへ
          </Button>
        ) : closed ? null : (
          <>
            {registered === 1 ? <p className="lk-text-xs leading-relaxed text-[#474747]">{MSG_ADVICE}</p> : null}
            {registered < 2 ? (
              <Button
                type="button"
                size="md"
                className="auth-action w-full"
                id="staff-register-primary"
                disabled={busy}
                aria-busy={busy}
                onClick={() => void addKey()}
              >
                {busy ? "登録しています…" : registered === 0 ? "1本目を登録" : "2本目を登録"}
              </Button>
            ) : null}
            {completable ? (
              <Button
                type="button"
                variant={registered < 2 ? "outline" : undefined}
                size="md"
                className="auth-action w-full"
                id={registered < 2 ? "staff-register-complete" : "staff-register-primary"}
                disabled={busy}
                aria-busy={busy}
                onClick={() => void complete()}
              >
                登録を完了する
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
