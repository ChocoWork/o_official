'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/Button/Button';
import { useLogin } from '@/contexts/LoginContext';
import { fetchCustomerReturnMaterials } from '@/features/account/returns/customer-return-client';
import { ReturnRequestForm } from '@/features/account/returns/ReturnRequestForm';
import { REQUEST_TEXT, availabilityMessageOf } from '@/features/account/returns/return-request-model';
import type { CustomerReturnRequestMaterials } from '@/lib/orders/returns/customer-return-types';
import '../../../account.css';

// アカウントの注文の画面（orders/[id]/page.tsx）と同じ、サイト共通の --lk-size-* トークンと見出しの書体
const bodyStyle = { fontSize: 'var(--lk-size-sm)' } as const;
const lgStyle = { fontSize: 'var(--lk-size-lg)' } as const;

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; notFound: boolean }
  | { kind: 'ready'; materials: CustomerReturnRequestMaterials };

/**
 * お客様の返品・交換の申し込みの画面 /account/orders/[id]/return（グループ E-3 段2。共通の約束 P7）。
 * ログインの確かめと読み込みの扱いは、アカウントの注文の画面（orders/[id]/page.tsx）に合わせる。
 * 申し込める時は ReturnRequestForm（3段）を出し、受付がオフ・終わった・対象が無い時は、その文と注文の画面へ戻るボタンだけを出す。
 */
export default function ReturnRequestPage() {
  const params = useParams<{ id: string }>();
  const { isLoggedIn, isAuthResolved } = useLogin();
  const [load, setLoad] = React.useState<LoadState>({ kind: 'loading' });

  React.useEffect(() => {
    if (!isAuthResolved || !isLoggedIn || !params.id) return;
    let active = true;
    setLoad({ kind: 'loading' });
    void fetchCustomerReturnMaterials(params.id).then((result) => {
      if (!active) return;
      setLoad(
        result.kind === 'ok'
          ? { kind: 'ready', materials: result.data }
          : { kind: 'error', message: result.message, notFound: result.notFound },
      );
    });
    return () => {
      active = false;
    };
  }, [isAuthResolved, isLoggedIn, params.id]);

  if (!isAuthResolved) {
    return (
      <div className="max-w-3xl mx-auto text-center">
        <p className="text-[#474747] mb-8" style={lgStyle}>
          {REQUEST_TEXT.loading}
        </p>
      </div>
    );
  }

  if (!isLoggedIn) {
    return (
      <div className="max-w-3xl mx-auto text-center">
        <h1 className="mb-4">{REQUEST_TEXT.title}</h1>
        <p className="text-[#474747] mb-8" style={lgStyle}>
          {REQUEST_TEXT.loginRequired}
        </p>
        <Button href="/login" variant="primary" size="lg">
          {REQUEST_TEXT.login}
        </Button>
      </div>
    );
  }

  // 申し込めない時の文。注文が無い・持ち主でない（404）は、存在を明かさないよう「受け付けていません」の文にする
  const unavailableMessage =
    load.kind === 'error'
      ? load.notFound
        ? REQUEST_TEXT.none
        : load.message
      : load.kind === 'ready'
        ? availabilityMessageOf(load.materials.availability)
        : null;

  return (
    // account-page: account.css の間隔変数のスコープ。カードは注文の画面と同じ border-black/10・p-5 sm:p-8
    <div className="account-page w-full mx-auto max-w-3xl min-w-0 space-y-6">
      <h1>{REQUEST_TEXT.title}</h1>

      {/* OD-7（注文の画面）と同じ: 読み込み中はスケルトン、読み込めなかった時は role="alert" */}
      {load.kind === 'loading' ? (
        <div className="border border-black/10 p-5 sm:p-8 animate-pulse space-y-4" aria-hidden="true">
          <div className="h-4 w-1/3 bg-black/8" />
          <div className="h-16 w-full bg-black/5" />
        </div>
      ) : null}

      {unavailableMessage !== null ? (
        <section className="border border-black/10 p-5 sm:p-8 space-y-4">
          <p role={load.kind === 'error' ? 'alert' : undefined} className="break-words text-black" style={bodyStyle}>
            {unavailableMessage}
          </p>
          <Button href={`/account/orders/${params.id}`} variant="secondary" size="md" className="w-full sm:w-auto">
            {REQUEST_TEXT.toOrder}
          </Button>
        </section>
      ) : null}

      {load.kind === 'ready' && unavailableMessage === null ? <ReturnRequestForm materials={load.materials} /> : null}
    </div>
  );
}
