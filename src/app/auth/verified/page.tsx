"use client";

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';

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

type PageMode = 'loading' | 'unauthenticated' | 'non-privileged' | 'mfa-challenge';

export default function VerifiedPage() {
  const [mode, setMode] = useState<PageMode>('loading');
  const [message, setMessage] = useState<string>('確認完了。認証状態を確認しています…');
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
      return <p className="mb-4">{message}</p>;
    }

    if (mode === 'unauthenticated') {
      return (
        <>
          <p className="mb-4">ログインが必要です。ログイン後に再度お試しください。</p>
          <a href="/login" className="text-blue-600">ログインページへ</a>
        </>
      );
    }

    if (mode === 'non-privileged') {
      return (
        <>
          <p className="mb-4">{message}</p>
          <a href="/account" className="text-blue-600">アカウントへ</a>
        </>
      );
    }

    return (
      <div className="space-y-4">
        <p>{message}</p>
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
        {totpSecret ? (
          <p className="text-xs text-[#474747] break-all">シークレット: {totpSecret}</p>
        ) : null}
        {totpUri ? (
          <p className="text-xs text-[#474747] break-all">セットアップURI: {totpUri}</p>
        ) : null}
        {enrollFactorId && !qrCodeSvg ? (
          <p className="text-xs text-[#474747]">
            QRコードが表示されない場合は、Google Authenticator の「セットアップキーを入力」から上記シークレットまたはセットアップURIを使って登録できます。
          </p>
        ) : null}

        {!qrCodeSvg && !enrollFactorId && verifiedFactors.length === 0 ? (
          <Button type="button" onClick={() => void handleEnrollTotp()} disabled={isProcessing} variant="secondary" size="md">
            {isProcessing ? '登録中...' : '2要素認証（TOTP）を登録'}
          </Button>
        ) : null}

        {verifiedFactors.length > 1 && !enrollFactorId ? (
          <select
            value={selectedFactorId ?? ''}
            onChange={(event) => setSelectedFactorId(event.target.value || null)}
            className="w-full border border-black/20 px-3 py-2 text-sm"
          >
            {verifiedFactors.map((factor) => (
              <option key={factor.id} value={factor.id}>
                {factor.label}
              </option>
            ))}
          </select>
        ) : null}

        {(enrollFactorId || verifiedFactors.length > 0) ? (
          <div className="space-y-3">
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={otpCode}
              onChange={(event) => setOtpCode(event.target.value.replace(/\D/g, '').slice(0, 8))}
              placeholder="6〜8桁の認証コード"
              className="w-full border border-black/20 px-3 py-2 text-sm"
            />
            <Button type="button" onClick={handleVerifyMfa} disabled={isProcessing} size="md">
              {isProcessing ? '検証中...' : '2要素認証を完了'}
            </Button>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="max-w-xl mx-auto p-6">
      <h1 className="mb-4">認証確認</h1>
      {renderBody()}
      {errorMessage ? <p className="mt-4 text-sm text-red-700">{errorMessage}</p> : null}
    </div>
  );
}
