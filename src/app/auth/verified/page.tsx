"use client";

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLogin } from '@/contexts/LoginContext';
import { Button } from '@/components/ui/Button/Button';
import { SingleSelect } from '@/components/ui/SingleSelect/SingleSelect';

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-black align-[-2px]"
    />
  );
}

type UserRole = 'admin' | 'supporter' | 'user';

type AuthMeResponse = {
  authenticated?: boolean;
  user?: {
    role?: unknown;
    mfaVerified?: boolean;
  };
};

type MfaStatusResponse = {
  data?: {
    role?: UserRole;
    currentLevel?: string | null;
    nextLevel?: string | null;
    hasVerifiedFactor?: boolean;
    needsChallenge?: boolean;
    factors?: Array<{
      id: string;
      factorType: string;
      friendlyName: string | null;
    }>;
  };
};

type EnrollTotpResponse = {
  data?: {
    factorId: string;
    friendlyName: string | null;
    qrCode: string;
    secret: string;
    uri: string;
  };
};

type VerifyMfaResponse = {
  data?: {
    verified?: boolean;
  };
};

const isUserRole = (role: unknown): role is UserRole => role === 'admin' || role === 'supporter' || role === 'user';

// ブランド世界観（Le Fil des Heures）に合わせたタイポ階層。対比のため見出しを最大に。
const authTitleStyle: React.CSSProperties = { fontSize: 'var(--lk-size-4xl)' };
const authBodyStyle: React.CSSProperties = { fontSize: 'var(--lk-size-lg)' };
const authNoteStyle: React.CSSProperties = { fontSize: 'var(--lk-size-sm)' };

type PageMode = 'loading' | 'unauthenticated' | 'non-privileged' | 'mfa-challenge';

export default function VerifiedPage() {
  const [mode, setMode] = useState<PageMode>('loading');
  const [message, setMessage] = useState<string>('サインインを確認しています…');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [enrollFactorId, setEnrollFactorId] = useState<string | null>(null);
  const [verifiedFactors, setVerifiedFactors] = useState<Array<{ id: string; label: string }>>([]);
  const [selectedFactorId, setSelectedFactorId] = useState<string | null>(null);
  const [qrCodeSvg, setQrCodeSvg] = useState<string | null>(null);
  const [totpSecret, setTotpSecret] = useState<string | null>(null);
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [hasAutoEnrollAttempted, setHasAutoEnrollAttempted] = useState(false);
  const router = useRouter();
  const { refreshAuthState } = useLogin();

  const loadMfaStatus = React.useCallback(async () => {
    const statusResponse = await fetch('/api/auth/mfa/status', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
    });

    if (!statusResponse.ok) {
      throw new Error('MFA状態の取得に失敗しました。');
    }

    const statusBody = (await statusResponse.json()) as MfaStatusResponse;
    const statusData = statusBody.data;
    const factors =
      statusData?.factors?.map((factor) => ({
        id: factor.id,
        label: factor.friendlyName || factor.factorType || 'MFA Factor',
      })) ?? [];

    setVerifiedFactors(factors);
    setSelectedFactorId((prev) => {
      if (prev && factors.some((factor) => factor.id === prev)) {
        return prev;
      }
      return factors[0]?.id ?? null;
    });

    if (statusData?.hasVerifiedFactor) {
      setMessage('2要素認証コードを入力してください。');
      setMode('mfa-challenge');
      return;
    }

    setMessage('管理画面利用のために2要素認証（TOTP）を登録してください。');
    setMode('mfa-challenge');
  }, []);

  useEffect(() => {
    let cancelled = false;
    let nonPrivilegedTimer: ReturnType<typeof setTimeout> | null = null;

    (async () => {
      try {
        const authResponse = await fetch('/api/auth/me', {
          method: 'GET',
          cache: 'no-store',
          credentials: 'same-origin',
        });

        const authBody = (await authResponse.json().catch(() => null)) as AuthMeResponse | null;
        const authenticated = authResponse.ok && authBody?.authenticated === true;

        if (!authenticated) {
          if (!cancelled) {
            setMode('unauthenticated');
            setMessage('ログインが必要です。');
          }
          return;
        }

        const role = isUserRole(authBody?.user?.role) ? authBody?.user?.role : 'user';
        const mfaVerified = authBody?.user?.mfaVerified === true;

        if (role === 'admin' || role === 'supporter') {
          if (mfaVerified) {
            if (!cancelled) {
              setMessage('認証が完了しました。管理画面へ移動します…');
              router.replace('/admin');
            }
            return;
          }

          if (!cancelled) {
            await loadMfaStatus();
          }
          return;
        }

        if (!cancelled) {
          setMode('non-privileged');
          setMessage('確認完了。アカウントへ移動します…');
          nonPrivilegedTimer = setTimeout(() => {
            router.replace('/account');
          }, 800);
        }
      } catch (error) {
        console.error('Failed to initialize auth verified page:', error);
        if (!cancelled) {
          setMode('mfa-challenge');
          setErrorMessage('認証状態の確認に失敗しました。もう一度ログインしてください。');
        }
      }
    })();

    return () => {
      cancelled = true;
      if (nonPrivilegedTimer) {
        clearTimeout(nonPrivilegedTimer);
      }
    };
  }, [loadMfaStatus, router]);

  const handleEnrollTotp = async (isAutomatic = false) => {
    setErrorMessage(null);
    if (isAutomatic) {
      setMessage('2要素認証（TOTP）をセットアップ中です…');
    }
    setIsProcessing(true);
    try {
      const response = await fetch('/api/auth/mfa/enroll-totp', {
        method: 'POST',
        credentials: 'same-origin',
      });

      const body = (await response.json().catch(() => null)) as EnrollTotpResponse | null;

      if (!response.ok || !body?.data) {
        const fallback = response.status === 409
          ? '既に2要素認証は登録済みです。コード入力へ進んでください。'
          : '2要素認証の登録に失敗しました。';
        throw new Error(fallback);
      }

      setEnrollFactorId(body.data.factorId);
      setQrCodeSvg(body.data.qrCode);
      setTotpSecret(body.data.secret);
      setTotpUri(body.data.uri);
      setMessage('認証アプリでQRコードを読み取り、生成されたコードを入力してください。');
    } catch (error) {
      console.error('Failed to enroll TOTP factor:', error);
      setErrorMessage(error instanceof Error ? error.message : '2要素認証の登録に失敗しました。');
    } finally {
      setIsProcessing(false);
    }
  };

  useEffect(() => {
    if (mode !== 'mfa-challenge') {
      return;
    }

    if (hasAutoEnrollAttempted) {
      return;
    }

    if (isProcessing || qrCodeSvg || enrollFactorId || verifiedFactors.length > 0) {
      return;
    }

    setHasAutoEnrollAttempted(true);
    void handleEnrollTotp(true);
  }, [mode, hasAutoEnrollAttempted, isProcessing, qrCodeSvg, enrollFactorId, verifiedFactors.length]);


  const handleVerifyMfa = async () => {
    if (!/^\d{6,8}$/.test(otpCode.trim())) {
      setErrorMessage('認証コードは6〜8桁の数字で入力してください。');
      return;
    }

    const factorId = enrollFactorId ?? selectedFactorId;
    if (!factorId) {
      setErrorMessage('検証対象のMFA要素がありません。先に登録または再読み込みしてください。');
      return;
    }

    setErrorMessage(null);
    setIsProcessing(true);
    try {
      const response = await fetch('/api/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ factorId, code: otpCode.trim() }),
      });

      const body = (await response.json().catch(() => null)) as VerifyMfaResponse | null;
      if (!response.ok || body?.data?.verified !== true) {
        throw new Error('2要素認証コードの検証に失敗しました。');
      }

      // グローバルな認証状態（isMfaVerified 等）を再同期してから遷移する。
      // これを省くと /admin がリロードするまで古い isMfaVerified=false を読み、
      // 「2要素認証が必要です」が誤表示される。
      await refreshAuthState();

      setMessage('2要素認証が完了しました。管理画面へ移動します…');
      router.replace('/admin');
    } catch (error) {
      console.error('Failed to verify MFA code:', error);
      setErrorMessage(error instanceof Error ? error.message : '2要素認証コードの検証に失敗しました。');
    } finally {
      setIsProcessing(false);
    }
  };

  const renderBody = () => {
    if (mode === 'loading') {
      return (
        <p
          className="flex items-center justify-center gap-2 text-[#474747]"
          role="status"
          aria-live="polite"
          style={authBodyStyle}
        >
          <Spinner />
          {message}
        </p>
      );
    }

    if (mode === 'unauthenticated') {
      return (
        <div className="space-y-6">
          <p className="text-black" style={authBodyStyle}>ログインが必要です。ログイン後に再度お試しください。</p>
          <a href="/login" className="inline-block underline underline-offset-4 hover:text-[#474747] transition-colors">ログインページへ</a>
        </div>
      );
    }

    if (mode === 'non-privileged') {
      return (
        <div className="space-y-6">
          <p
            className="flex items-center justify-center gap-2 text-[#474747]"
            role="status"
            aria-live="polite"
            style={authBodyStyle}
          >
            <Spinner />
            {message}
          </p>
          <a href="/account" className="inline-block underline underline-offset-4 hover:text-[#474747] transition-colors">アカウントへ</a>
        </div>
      );
    }

    return (
      <div className="space-y-4 text-left">
        <p style={authBodyStyle}>{message}</p>
        <p className="text-xs text-[#474747]">
          ここで入力するのは、Google Authenticator などの認証アプリに表示される 6〜8 桁のワンタイムコードです。
        </p>
        {qrCodeSvg ? (
          <img
            src={qrCodeSvg}
            alt="TOTP QR code"
            className="h-48 w-48 border border-black/20 p-2"
          />
        ) : null}
        {totpSecret || totpUri ? (
          <details className="text-xs text-[#474747]">
            <summary className="cursor-pointer underline underline-offset-4 hover:text-black transition-colors">
              手動で入力する場合はこちら
            </summary>
            <div className="mt-2 space-y-2">
              {totpSecret ? <p className="break-all">シークレット: {totpSecret}</p> : null}
              {totpUri ? <p className="break-all">セットアップURI: {totpUri}</p> : null}
              <p>
                QRコードが表示されない場合は、Google Authenticator の「セットアップキーを入力」から上記シークレットまたはセットアップURIを使って登録できます。
              </p>
            </div>
          </details>
        ) : null}

        {!qrCodeSvg && !enrollFactorId && verifiedFactors.length === 0 ? (
          <Button
            type="button"
            onClick={() => void handleEnrollTotp()}
            disabled={isProcessing}
            variant="secondary"
            size="xl"
            shape="rounded"
            className="w-full"
            style={{ minHeight: '3rem' }}
          >
            {isProcessing ? '登録中...' : '2要素認証（TOTP）を登録'}
          </Button>
        ) : null}

        {verifiedFactors.length > 1 && !enrollFactorId ? (
          <SingleSelect
            label="認証要素"
            block
            value={selectedFactorId ?? ''}
            onValueChange={(value) => setSelectedFactorId(value || null)}
            options={verifiedFactors.map((factor) => ({ value: factor.id, label: factor.label }))}
          />
        ) : null}

        {(enrollFactorId || verifiedFactors.length > 0) ? (
          <div className="space-y-3">
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="認証コード（6〜8桁）"
              value={otpCode}
              onChange={(event) => setOtpCode(event.target.value.replace(/\D/g, '').slice(0, 8))}
              placeholder="6〜8桁の認証コード"
              className="w-full h-11 border border-black/20 rounded-lg px-3 text-center tracking-[0.4em] outline-none transition-colors duration-200 focus:border-black"
              style={authBodyStyle}
            />
            <Button
              type="button"
              onClick={handleVerifyMfa}
              disabled={isProcessing}
              size="xl"
              shape="rounded"
              className="w-full"
              style={{ minHeight: '3rem' }}
            >
              {isProcessing ? '検証中...' : '2要素認証を完了'}
            </Button>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex min-h-[calc(100dvh-6.5rem)] w-full flex-col items-center justify-center px-6 py-16 text-center">
      {/* ブランドフォント Didot（h1 既定）。認証確認をブランドの一場面として見せる */}
      <h1 className="mb-4 tracking-[0.18em]" style={authTitleStyle}>
        Le Fil des Heures
      </h1>
      {/* 糸のモチーフ：一本の細いヘアライン（Le Fil des Heures＝時間の糸） */}
      <span aria-hidden="true" className="mb-8 block h-10 w-px bg-black/30" />

      <div className="w-full max-w-md">{renderBody()}</div>

      {errorMessage ? (
        <p role="alert" className="mt-6 text-red-600" style={authNoteStyle}>
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
