'use client';

// File: src/features/discounts/components/DiscountMemberPicker.tsx
// 会員を名前かメールアドレスで探して選ぶ（グループ H / FREQ-547-AC-05）。
// 探すのは2文字から・入力が止まって300ms後・1回20人まで。前の検索は AbortController で止め、遅れて届いた古い答えは捨てる。
// 非 ok の応答は本文を読み切ってから文を出す。選べるのは100人まで（1回に作る束・割り当ての上限）。
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { clientFetch } from '@/lib/client-fetch';
import type { DiscountMember } from '@/lib/discounts/admin-discount-types';
import { MAX_DISCOUNT_BATCH } from '@/lib/discounts/discount-types';
import { readDiscountFailure } from '../discount-admin-client';
import { DiscountField, INPUT_CLASS } from './DiscountField';

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 300;
const SEARCH_FAILED = '会員を探せませんでした。';
const SEARCH_FORBIDDEN = '会員を探す権限がありません。';
const NO_RESULT = '該当する会員はいません。';

export const memberLabel = (member: DiscountMember): string => member.name ? `${member.name}（${member.email}）` : member.email;

function isMembers(value: unknown): value is DiscountMember[] {
  return Array.isArray(value) && value.every((member) => {
    const m = member as Record<string, unknown> | null;
    return typeof m === 'object' && m !== null && typeof m.userId === 'string' && typeof m.email === 'string' && (m.name === null || typeof m.name === 'string');
  });
}

export default function DiscountMemberPicker({ selected, onChange }: {
  selected: readonly DiscountMember[];
  onChange: (members: DiscountMember[]) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DiscountMember[]>([]);
  const [status, setStatus] = useState<'idle' | 'searching' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const searchSeq = useRef(0);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    searchSeq.current += 1;
    controller.current?.abort();
    controller.current = null;
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setStatus('idle');
      setMessage(null);
      return undefined;
    }
    const requestId = searchSeq.current;
    const isLatest = () => requestId === searchSeq.current;
    const timer = setTimeout(() => {
      const abort = new AbortController();
      controller.current = abort;
      setStatus('searching');
      setMessage(null);
      void (async () => {
        try {
          const response = await clientFetch(`/api/admin/discounts/members?query=${encodeURIComponent(trimmed)}`, { cache: 'no-store', signal: abort.signal });
          if (!response.ok) {
            const failure = await readDiscountFailure(response, SEARCH_FAILED, SEARCH_FORBIDDEN);
            if (isLatest()) { setResults([]); setStatus('error'); setMessage(failure.message); }
            return;
          }
          const json = (await response.json()) as { data?: unknown };
          if (!isLatest()) return;
          if (!isMembers(json.data)) { setResults([]); setStatus('error'); setMessage(SEARCH_FAILED); return; }
          setResults(json.data);
          setStatus('done');
        } catch (error) {
          if (abort.signal.aborted || !isLatest()) return;
          console.error('Failed to search discount members:', error instanceof Error ? error.name : 'UnknownError');
          setResults([]); setStatus('error'); setMessage(SEARCH_FAILED);
        }
      })();
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => () => {
    searchSeq.current += 1;
    controller.current?.abort();
  }, []);

  const selectedIds = new Set(selected.map((member) => member.userId));
  const full = selected.length >= MAX_DISCOUNT_BATCH;
  const add = (member: DiscountMember): void => {
    if (selectedIds.has(member.userId) || full) return;
    onChange([...selected, member]);
  };
  const remove = (userId: string): void => onChange(selected.filter((member) => member.userId !== userId));
  const candidates = results.filter((member) => !selectedIds.has(member.userId));

  return (
    <div className="min-w-0 space-y-3">
      <DiscountField label="会員を探す" hint={`名前かメールアドレスを${MIN_QUERY_LENGTH}文字から入力します。`}>
        {(props) => <input {...props} type="text" maxLength={100} autoComplete="off" className={INPUT_CLASS} value={query} onChange={(event) => setQuery(event.target.value)} />}
      </DiscountField>
      {status === 'searching' ? <p role="status" className="lk-text-3xs text-[#474747] font-acumin">探しています…</p> : null}
      {status === 'error' && message ? <p role="alert" className="lk-text-sm text-red-700 font-acumin">{message}</p> : null}
      {status === 'done' && candidates.length === 0 ? <p role="status" className="lk-text-sm text-[#474747] font-acumin">{NO_RESULT}</p> : null}
      {candidates.length > 0 ? (
        <ul aria-label="探した会員" className="max-h-60 divide-y divide-black/10 overflow-auto border border-black/15">
          {candidates.map((member) => (
            <li key={member.userId} className="flex min-w-0 items-center justify-between gap-3 p-2">
              <span className="min-w-0 break-all lk-text-sm font-acumin">{memberLabel(member)}</span>
              <Button variant="secondary" size="sm" className="shrink-0 font-acumin" disabled={full} aria-label={`${memberLabel(member)}を追加`} onClick={() => add(member)}>追加</Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="space-y-2">
        <p className="lk-text-3xs font-acumin">選んだ会員 {selected.length}人{full ? `（選べるのは${MAX_DISCOUNT_BATCH}人までです）` : ''}</p>
        {selected.length > 0 ? (
          <ul aria-label="選んだ会員" className="divide-y divide-black/10 border border-black/15">
            {selected.map((member) => (
              <li key={member.userId} className="flex min-w-0 items-center justify-between gap-3 p-2">
                <span className="min-w-0 break-all lk-text-sm font-acumin">{memberLabel(member)}</span>
                <Button variant="secondary" size="sm" className="shrink-0 font-acumin" aria-label={`${memberLabel(member)}の選択を取り消す`} onClick={() => remove(member.userId)}>取り消す</Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
