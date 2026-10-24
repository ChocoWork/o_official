/**
 * ホームの `/?q=` で結果の先頭3件だけを先に見せる、検索のプレビューの部品。
 *
 * @packageDocumentation
 * @impl IMPL-SEARCH-103
 * @design DD-SEARCH-003
 * @remarks ホームの場所を取りすぎないよう、プレビュー用の枠（1種別3件・別の回数の枠）で窓口を呼んで先頭3件だけを出す（DRV-SEARCH-010）。
 * プレビューはホームの付け足しなので、取り出しに失敗したら区画ごと出さず、ホームの本体を邪魔しない（SCR-SEARCH-004）。
 * 題・説明・検索語の記号をタグとして解釈すると画面に差し込まれてしまうので、すべて文字のまま出す（SEC-SEARCH-013）。
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
      } catch (error) {
        console.error('Failed to fetch home search preview:', error);
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
            <p className="mt-2 leading-relaxed text-[#474747]" style={previewTextStyle}>「{query}」に関連する結果をホーム上で即時プレビューしています。</p>
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