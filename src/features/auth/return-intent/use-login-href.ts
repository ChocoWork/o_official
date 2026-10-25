/**
 * ログインの入口のリンクの URL を作る（src/features/auth/return-intent/use-login-href.ts）。
 *
 * @packageDocumentation
 * @remarks ヘッダーのログインと会員だけの頁の門は、今いる頁を `next` に載せて `/login` へ送る。
 * 載せる値はサーバーが入口でもう一度確かめる（DD-AUTH-034）ので、ここでの確かめは不要な `next` を付けないためだけの物。
 */
'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { validateReturnPath } from './return-path';

const LOGIN_PATH = '/login';

/** サーバーの描画では window が無い。道筋は相対なので、基準の origin は何でも結果が変わらない。 */
const FALLBACK_ORIGIN = 'http://localhost';

/**
 * 戻り先の確かめを通った道筋だけを `next` に載せたログインの URL を返す。
 *
 * @impl IMPL-AUTH-210
 * @design DD-AUTH-036
 * @remarks 外れた物（`/login`・`/auth/*`・`/api/*`・許可リスト外・外の住所）は `next` なしの `/login`。
 * ホーム `/` も `next` を付けない（既定と同じで、管理者が戻り先なしなら管理の頁へ着く今の挙動を保つため）。
 */
export function buildLoginHref(path: string | null | undefined, origin?: string): string {
  const base = origin ?? (typeof window === 'undefined' ? FALLBACK_ORIGIN : window.location.origin);
  const result = validateReturnPath(path, { origin: base });
  return result.ok && result.path !== '/' ? `${LOGIN_PATH}?next=${encodeURIComponent(result.path)}` : LOGIN_PATH;
}

/**
 * 今いる頁（道筋と検索条件）を戻り先に載せたログインの URL を返す。
 *
 * @impl IMPL-AUTH-219
 * @design DD-AUTH-036
 * @remarks 検索条件は端末でしか分からない。`useSearchParams` は静的な頁に Suspense を要求するので使わず、
 * 最初の描画（サーバーと同じ）は道筋だけにして、効果の後に足す。道筋が変わった直後に前の頁の検索条件を載せないよう、
 * 検索条件は取った時の道筋と組で持つ。
 */
export function useLoginHref(): string {
  const pathname = usePathname();
  const [seen, setSeen] = useState<{ pathname: string; search: string } | null>(null);

  useEffect(() => {
    setSeen({ pathname, search: window.location.search });
  }, [pathname]);

  const search = seen && seen.pathname === pathname ? seen.search : '';
  return buildLoginHref(`${pathname}${search}`);
}
