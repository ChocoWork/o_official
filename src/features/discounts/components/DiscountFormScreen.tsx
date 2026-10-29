'use client';

// File: src/features/discounts/components/DiscountFormScreen.tsx
// 割引の作成（/admin/discounts/new）と編集（/admin/discounts/[id]/edit）の頁の中身。
// 編集では詳細を読んでからフォームを出す。操作の権限（admin.discounts.manage）が無い人には、フォームを出さず権限の文を出す。
// 保存の後は割引の詳細へ移る。
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { clientFetch } from '@/lib/client-fetch';
import { Button } from '@/components/ui/Button/Button';
import type { AdminDiscountDetail } from '@/lib/discounts/admin-discount-types';
import { DISCOUNT_TEXT, fetchDiscountDetail, readDiscountFailure, type DiscountDetailResult } from '../discount-admin-client';
import DiscountForm from './DiscountForm';

const BACK_HREF = '/admin?tab=DISCOUNT';

export default function DiscountFormScreen({ discountId }: { discountId?: string }): React.JSX.Element {
  const router = useRouter();
  const [result, setResult] = useState<DiscountDetailResult | null>(null);
  const [createAccess, setCreateAccess] = useState<{ manage: boolean } | { error: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!discountId) {
      void (async () => {
        try {
          const response = await clientFetch('/api/admin/discounts?page=1', { cache: 'no-store' });
          if (!response.ok) {
            const failure = await readDiscountFailure(response, DISCOUNT_TEXT.listFailed, DISCOUNT_TEXT.manageForbidden);
            if (!cancelled) setCreateAccess({ error: failure.message });
            return;
          }
          const json = await response.json() as { permissions?: { manage?: unknown } };
          if (!cancelled) setCreateAccess(typeof json.permissions?.manage === 'boolean' ? { manage: json.permissions.manage } : { error: DISCOUNT_TEXT.listFailed });
        } catch {
          if (!cancelled) setCreateAccess({ error: DISCOUNT_TEXT.listFailed });
        }
      })();
      return () => { cancelled = true; };
    }
    void fetchDiscountDetail(discountId, 1).then((next) => { if (!cancelled) setResult(next); });
    return () => { cancelled = true; };
  }, [discountId, attempt]);

  const onSaved = (id: string): void => router.push(`/admin/discounts/${id}`);
  const back = <Button href={discountId ? `/admin/discounts/${discountId}` : BACK_HREF} variant="secondary">{discountId ? '詳細に戻る' : '一覧に戻る'}</Button>;

  let body: React.JSX.Element;
  if (!discountId) {
    body = createAccess === null ? <p role="status">{DISCOUNT_TEXT.loading}</p>
      : 'error' in createAccess ? <div><p role="alert">{createAccess.error}</p><Button variant="secondary" onClick={() => { setCreateAccess(null); setAttempt((n) => n + 1); }}>{DISCOUNT_TEXT.reload}</Button></div>
      : !createAccess.manage ? <p role="alert">{DISCOUNT_TEXT.manageForbidden}</p>
      : <DiscountForm initial={null} onSaved={onSaved} />;
  } else if (result === null) {
    body = <p role="status" className="lk-text-sm font-acumin">{DISCOUNT_TEXT.loading}</p>;
  } else if (result.kind === 'forbidden') {
    body = <p role="alert" className="lk-text-sm text-red-700 font-acumin">{DISCOUNT_TEXT.listForbidden}</p>;
  } else if (result.kind === 'notFound') {
    body = <p role="alert" className="lk-text-sm text-red-700 font-acumin">{DISCOUNT_TEXT.detailNotFound}</p>;
  } else if (result.kind === 'error') {
    body = (
      <div className="space-y-3">
        <p role="alert" className="lk-text-sm text-red-700 font-acumin">{result.message}</p>
        <Button variant="secondary" size="sm" className="font-acumin" onClick={() => { setResult(null); setAttempt((n) => n + 1); }}>{DISCOUNT_TEXT.reload}</Button>
      </div>
    );
  } else if (!result.data.permissions.manage) {
    body = <p role="alert" className="lk-text-sm text-red-700 font-acumin">{DISCOUNT_TEXT.manageForbidden}</p>;
  } else {
    const detail: AdminDiscountDetail = result.data;
    body = <DiscountForm key={`${detail.discount.id}:${detail.discount.version}`} initial={detail} onSaved={onSaved} />;
  }

  return (
    <div className="w-full min-w-0 max-w-full space-y-6">
      {back}
      <h1 className="lk-text-xl">{discountId ? '割引を変える' : '割引を作る'}</h1>
      {body}
    </div>
  );
}
