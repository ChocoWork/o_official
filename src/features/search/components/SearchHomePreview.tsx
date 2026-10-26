/**
 * ホームの `/?q=` で結果の先頭3件だけを先に見せる、検索のプレビューの部品。
 *
 * @packageDocumentation
 * @impl IMPL-SEARCH-103
 * @design DD-SEARCH-003
 * @remarks ホームの場所を取りすぎないよう、プレビュー用の枠（1種別3件・別の回数の枠）で窓口を呼んで先頭3件だけを出す（DRV-SEARCH-010）。
 * プレビューはホームの付け足しなので、取り出しに失敗したら区画ごと出さず、ホームの本体を邪魔しない（SCR-SEARCH-004）。
 * 題・説明・検索語の記号をタグとして解釈すると画面に差し込まれてしまうので、すべて文字のまま出す（SEC-SEARCH-013）。
 * 説明の文は固定にし、URL から来る検索語は別の「検索した語」の枠（dl）にだけ出す。文に埋めると、細工したリンクで公式の画面の文面を書き換えられるため（SEC-SEARCH-021、ADR-0314）。
 * 取り出しの失敗は固定の文字だけ記録する。Error を渡すと stack に内部の道筋が残る（SEC-HOME-015）。
 */
'use client';

import Link from 'next/link';
import React from 'react';
import { useSearchParams } from 'next/navigation';
import type { SearchResultsResponse } from '@/features/search/types/search.types';

export function SearchHomePreview() {
  const searchParams = useSearchParams();
  const query = searchParams.get('q')?.trim() ?? '';
  const [results, setResults] = React.useState<SearchResultsResponse | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    const fetchPreview = async () => {
      if (query.length === 0) {
        setResults(null);
        return;
      }

      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&preview=true`, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error('Failed to fetch preview');
        }

        const payload = (await response.json()) as SearchResultsResponse;
        if (!cancelled) {
          setResults(payload);
        }
      } catch {
        console.error('Failed to fetch home search preview');
        if (!cancelled) {
          setResults(null);
        }
      }
    };

    void fetchPreview();

    return () => {
      cancelled = true;
    };
  }, [query]);

  if (query.length === 0 || !results) {
    return null;
  }

  const previewResults = [...results.items, ...results.looks, ...results.news].slice(0, 3);
  const previewTextStyle = { fontSize: 'var(--lk-size-md)' } as const;

  return (
    <section className="px-6 lg:px-12 py-10 bg-[#f7f5ef] border-y border-black/10">
      <div className="mx-auto max-w-7xl space-y-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="tracking-[0.3em] text-black/50" style={previewTextStyle}>PREVIEW</p>
            <h2 style={previewTextStyle}>Search Preview</h2>
            <p className="mt-2 leading-relaxed text-[#474747]" style={previewTextStyle}>入力した語に関連する結果をホーム上で即時プレビューしています。</p>
            <dl
              data-testid="search-preview-term"
              className="mt-3 inline-flex max-w-full items-baseline gap-3 border border-black/10 bg-white px-4 py-2"
              style={previewTextStyle}
            >
              <dt className="shrink-0 tracking-widest text-black/50">検索した語</dt>
              <dd className="min-w-0 break-words text-black">{query}</dd>
            </dl>
          </div>
          <Link href={`/search?q=${encodeURIComponent(query)}`} className="tracking-widest text-black transition-colors hover:text-[#474747]" style={previewTextStyle}>
            VIEW ALL RESULTS
          </Link>
        </div>

        {previewResults.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-3">
            {previewResults.map((result) => (
              <Link key={`${result.type}-${result.id}`} href={result.href} className="rounded-2xl border border-black/10 bg-white p-5 transition-colors hover:border-black/30">
                <p className="mb-2 tracking-widest text-black/50" style={previewTextStyle}>{result.meta}</p>
                <h3 className="leading-snug text-black font-display" style={previewTextStyle}>{result.title}</h3>
                <p className="mt-2 leading-relaxed text-[#474747]" style={previewTextStyle}>{result.description}</p>
              </Link>
            ))}
          </div>
        ) : (
          <p className="text-[#474747]" style={previewTextStyle}>プレビュー対象の検索結果は見つかりませんでした。</p>
        )}
      </div>
    </section>
  );
}