/**
 * パスワード変更の画面の本体。現行パスワード → 確認コードと新しいパスワード → ログインへ、の 2 段（src/app/account/password/PasswordChangeForm.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-232
 * @design DD-AUTH-042
 * @remarks 窓口を 2 つに分けた順（start で現行パスワード、confirm でコードと新パスワード）をそのまま画面の段にする。
 * 新パスワードの長さと確認欄の一致は送る前に画面で確かめ、コードを送ってから弱いパスワードで弾かれる往復を減らす。
 * Google だけで登録した会員はパスワードを持たず start が必ず 401 になるので、段 1 に再設定への案内を誰にでも固定で出す
 * （会員がパスワードを持つかを明かさない）。応答は成否によらず本文を読み切る（読まない呼び手が networkidle を止める）。
 * 成功したら全 session が失効しているので、ログインの状態を引き直してから /login へ移る。
 * 401 の `Unauthorized`（途中で access token が切れた）は、印を 1 回だけ更新して同じ本文で 1 回送り直す。更新できない時だけ /login へ移す。
 */
'use client';

import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLogin } from '@/contexts/LoginContext';
import { Button } from '@/components/ui/Button/Button';
import { LiveMessage } from '@/components/ui/LiveMessage/LiveMessage';
import { TextField } from '@/components/ui/TextField/TextField';
import { clientFetch, refreshSessionOnce } from '@/lib/client-fetch';
import { useLoginHref } from '@/features/auth/return-intent/use-login-href';
import '../account.css';

const START_PATH = '/api/auth/password/change/start';
const CONFIRM_PATH = '/api/auth/password/change/confirm';

const MESSAGES = {
  rateLimited: 'しばらくしてからお試しください。',
  aal2Required: '二段階認証を完了してから、もう一度お試しください。',
  failed: '処理に失敗しました。時間をおいて、もう一度お試しください。',
  invalidInput: '入力に誤りがあります。',
  currentInvalid: '現行のパスワードが正しくありません。',
  codeInvalid: '確認コードが正しくないか、期限が切れています。もう一度コードを送ってください。',
  codeFormat: '確認コードは8桁の数字で入力してください',
  passwordShort: 'パスワードは16文字以上で入力してください',
  passwordTooLong: 'パスワードは72バイト以内にしてください（全角の文字は1文字で3バイトです）',
  passwordMismatch: '新しいパスワードが一致しません',
  done: 'パスワードを変更しました。全ての端末からログアウトしました。新しいパスワードでログインしてください。',
} as const;

const bodyStyle = { fontSize: 'var(--lk-size-sm)' } as const;
const lgStyle = { fontSize: 'var(--lk-size-lg)' } as const;

type Stage = 'current' | 'code' | 'done';
type Outcome =
  | { kind: 'ok' }
  | { kind: 'login' }
  | { kind: 'error'; message: string };

type Reply = { status: number; body: Record<string, unknown> | null };

/** 応答を本文まで読み切って、画面に出す形に畳む。通信の失敗は status 0。 */
async function send(path: string, payload: Record<string, string>): Promise<Reply> {
  try {
    const response = await clientFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: response.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

/**
 * 送る。access token が手続きの途中（メールを開いてコードを取る間）で切れて 401 の `Unauthorized` が返った時だけ、
 * 印を 1 回更新して同じ本文で 1 回だけ送り直す。窓口の `Unauthorized` は何かを変える前に返り、更新は
 * `session_id` を変えないので、送り直しても二重にならず、前のコードも使える。更新できなければ呼び手が /login へ送る。
 */
async function post(path: string, payload: Record<string, string>): Promise<Reply> {
  const first = await send(path, payload);
  if (first.status !== 401 || first.body?.error !== 'Unauthorized') return first;
  if ((await refreshSessionOnce()) !== 'refreshed') return first;
  return send(path, payload);
}

/** 窓口の文を画面に出してよいのは 400（形・漏洩）と 401（現行パスワード・コード）だけ。ほかは固定の文。 */
function toOutcome(status: number, body: Record<string, unknown> | null, fallback401: string): Outcome {
  if (status >= 200 && status < 300) return { kind: 'ok' };
  const serverText = typeof body?.error === 'string' ? body.error : typeof body?.message === 'string' ? body.message : null;
  if (status === 401) {
    if (body?.error === 'Unauthorized') return { kind: 'login' };
    return { kind: 'error', message: serverText ?? fallback401 };
  }
  if (status === 400) return { kind: 'error', message: serverText ?? MESSAGES.invalidInput };
  if (status === 403) return { kind: 'error', message: MESSAGES.aal2Required };
  if (status === 429) return { kind: 'error', message: MESSAGES.rateLimited };
  return { kind: 'error', message: MESSAGES.failed };
}

export function PasswordChangeForm() {
  const router = useRouter();
  const loginHref = useLoginHref();
  const { isLoggedIn, isAuthResolved, refreshAuthState } = useLogin();
  const [stage, setStage] = React.useState<Stage>('current');
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [code, setCode] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const backToCurrent = () => {
    setStage('current');
    setCurrentPassword('');
    setCode('');
    setNewPassword('');
    setConfirmPassword('');
    setError(null);
  };

  const handleStart = async (event: React.FormEvent) => {
    event.preventDefault();
    if (loading) return;
    setError(null);
    if (currentPassword.length === 0) {
      setError(MESSAGES.currentInvalid);
      return;
    }

    setLoading(true);
    try {
      const { status, body } = await post(START_PATH, { current_password: currentPassword });
      const outcome = toOutcome(status, body, MESSAGES.currentInvalid);
      if (outcome.kind === 'login') {
        router.replace(loginHref);
        return;
      }
      if (outcome.kind === 'error') {
        setError(outcome.message);
        return;
      }
      setCurrentPassword('');
      setStage('code');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async (event: React.FormEvent) => {
    event.preventDefault();
    if (loading) return;
    setError(null);

    if (!/^\d{8}$/.test(code)) {
      setError(MESSAGES.codeFormat);
      return;
    }
    if (newPassword.length < 16) {
      setError(MESSAGES.passwordShort);
      return;
    }
    if (new TextEncoder().encode(newPassword).length > 72) {
      setError(MESSAGES.passwordTooLong);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(MESSAGES.passwordMismatch);
      return;
    }

    setLoading(true);
    try {
      const { status, body } = await post(CONFIRM_PATH, { code, new_password: newPassword });
      const outcome = toOutcome(status, body, MESSAGES.codeInvalid);
      if (outcome.kind === 'login') {
        router.replace(loginHref);
        return;
      }
      if (outcome.kind === 'error') {
        setError(outcome.message);
        return;
      }
      setCode('');
      setNewPassword('');
      setConfirmPassword('');
      setStage('done');
      try {
        await refreshAuthState();
      } catch {
        // 状態の引き直しに失敗しても、/login へ移れば入口の確かめが改めて走る。
      }
      router.replace('/login');
    } finally {
      setLoading(false);
    }
  };

  if (!isAuthResolved) {
    return (
      <div className="max-w-3xl mx-auto text-center">
        <p className="text-[#474747] mb-8" style={lgStyle}>
          読み込み中...
        </p>
      </div>
    );
  }

  // 成功の直後は全 session が失効し、ログインの状態も外れる。移るまでの間、ゲートに切り替えず成功の文を残す。
  if (stage === 'done') {
    return (
      <div className="account-page w-full mx-auto max-w-3xl min-w-0 space-y-6">
        <h1>パスワードの変更</h1>
        <LiveMessage politeness="status" className="break-words text-black" style={bodyStyle}>
          {MESSAGES.done}
        </LiveMessage>
      </div>
    );
  }

  if (!isLoggedIn) {
    return (
      <div className="max-w-3xl mx-auto text-center">
        <h1 className="mb-4">パスワードの変更</h1>
        <p className="text-[#474747] mb-8" style={lgStyle}>
          パスワードの変更には、ログインが必要です。
        </p>
        <Button href={loginHref} variant="primary" size="lg">
          ログイン
        </Button>
      </div>
    );
  }

  return (
    <div className="account-page w-full mx-auto max-w-3xl min-w-0 space-y-6">
      <h1>パスワードの変更</h1>

      <section className="border border-black/10 p-5 sm:p-8 space-y-4">
        {stage === 'current' ? (
          <form className="space-y-4" onSubmit={handleStart} noValidate>
            <p className="break-words text-[#474747]" style={bodyStyle}>
              現行のパスワードを入力すると、登録のメールアドレスに確認コードを送ります。
            </p>
            <TextField
              shape="underline"
              size="sm"
              label="現行のパスワード"
              type="password"
              name="current_password"
              autoComplete="current-password"
              maxLength={128}
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
            <p className="break-words text-[#474747]" style={bodyStyle}>
              Google でログインしていてパスワードを設定していない場合は、先に
              <Link href="/auth/password-reset" className="underline">
                パスワードの再設定
              </Link>
              からパスワードを設定してください。
            </p>
            <LiveMessage className="break-words text-red-600" style={bodyStyle}>
              {error}
            </LiveMessage>
            <div className="account-actions">
              <Button type="submit" size="sm" className="font-acumin" disabled={loading}>
                {loading ? '送信中...' : '確認コードをメールに送る'}
              </Button>
            </div>
          </form>
        ) : (
          <form className="space-y-4" onSubmit={handleConfirm} noValidate>
            <p className="break-words text-[#474747]" style={bodyStyle}>
              メールに届いた8桁の確認コード（有効期限は10分）と、新しいパスワード（16文字以上、72バイト以内。全角の文字は1文字で3バイト）を入力してください。
            </p>
            <TextField
              shape="underline"
              size="sm"
              label="確認コード"
              type="text"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={8}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <TextField
              shape="underline"
              size="sm"
              label="新しいパスワード"
              type="password"
              name="new_password"
              autoComplete="new-password"
              maxLength={128}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
            <TextField
              shape="underline"
              size="sm"
              label="新しいパスワード（確認）"
              type="password"
              name="confirm_password"
              autoComplete="new-password"
              maxLength={128}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
            <LiveMessage className="break-words text-red-600" style={bodyStyle}>
              {error}
            </LiveMessage>
            <div className="account-actions">
              <Button type="submit" size="sm" className="font-acumin" disabled={loading}>
                {loading ? '変更中...' : 'パスワードを変更する'}
              </Button>
              <Button type="button" variant="secondary" size="sm" className="font-acumin" onClick={backToCurrent} disabled={loading}>
                コードを送り直す
              </Button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
