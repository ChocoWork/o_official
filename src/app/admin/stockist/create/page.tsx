/**
 * 取扱店の作成のページ（src/app/admin/stockist/create/page.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-STOCKIST-123
 * @design DD-STOCKIST-032
 * @remarks 作成と編集の決まりを共通のフォーム1つに置くため、この頁は作成の送り先と POST を渡すだけにする（SCR-STOCKIST-005）。管理のタブの「新規作成」から入る（FLOW-STOCKIST-002）。
 * フォームを出す前に権限の確かめ（GET /api/admin/stockists/access）を通し、書けない人や未ログインの人にフォームを見せない（SEC-STOCKIST-019、DD-STOCKIST-040、ADR-0269）。窓口は書き込みの時にも権限を確かめるので、この確かめは画面の入口を閉じるためのもの。
 */
'use client';

import { useEffect, useState } from 'react';
import { StockistForm } from '../StockistForm';
import { clientFetch } from '@/lib/client-fetch';

type AccessState = 'checking' | 'allowed' | { error: string };

const UNAUTHENTICATED_MESSAGE = 'ログインが必要です';
const FORBIDDEN_MESSAGE = 'STOCKISTを作成する権限がありません';
const FAILED_MESSAGE = '権限の確認に失敗しました';

function messageForStatus(status: number): string {
  if (status === 401) return UNAUTHENTICATED_MESSAGE;
  if (status === 403) return FORBIDDEN_MESSAGE;
  return FAILED_MESSAGE;
}

export default function AdminStockistCreatePage() {
  const [access, setAccess] = useState<AccessState>('checking');

  useEffect(() => {
    let cancelled = false;

    const checkAccess = async () => {
      try {
        const response = await clientFetch('/api/admin/stockists/access');
        if (response.ok) {
          if (!cancelled) setAccess('allowed');
          return;
        }
        // no-store の応答の本文を読まずに捨てると、ブラウザが要求を開いたまま残す。使わなくても読み切る
        await response.arrayBuffer().catch(() => undefined);
        if (!cancelled) setAccess({ error: messageForStatus(response.status) });
      } catch (error) {
        console.error('Failed to check stockist create access:', error);
        if (!cancelled) setAccess({ error: FAILED_MESSAGE });
      }
    };

    void checkAccess();

    return () => {
      cancelled = true;
    };
  }, []);

  if (access === 'checking') {
    return (
      <main className="pt-32 pb-20">
        <div className="max-w-4xl mx-auto px-6 lg:px-12 text-center">読み込み中...</div>
      </main>
    );
  }

  if (access !== 'allowed') {
    return (
      <main className="pt-32 pb-20">
        <div className="max-w-4xl mx-auto px-6 lg:px-12 text-center text-red-600">{access.error}</div>
      </main>
    );
  }

  return <StockistForm submitUrl="/api/admin/stockists" submitMethod="POST" />;
}
