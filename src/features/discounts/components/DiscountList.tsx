'use client';

// File: src/features/discounts/components/DiscountList.tsx
// 割引の一覧（グループ H / FREQ-547-AC-01）。7列（割引名・種類・効き方・状態・期間・使った回数・上限）を20件ずつ読み、
// 状態・種類・効き方で絞り込み、名前とコードで探す。読みは最後に始めた物の答えだけを使う。
// 見られるのは admin.discounts.read、「割引を作る」は応答の permissions.manage があるときだけ（窓口と DB が守る）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { clientFetch } from '@/lib/client-fetch';
import type { DiscountListRow, DiscountListStatus, DiscountPermissions } from '@/lib/discounts/admin-discount-types';
import { DISCOUNT_PAGE_SIZE, type DiscountKind, type DiscountMethod } from '@/lib/discounts/discount-types';
import {
  DISCOUNT_TEXT, KIND_LABELS, KIND_ORDER, METHOD_LABELS, STATUS_LABELS, STATUS_ORDER, formatJst, readDiscountFailure,
} from '../discount-admin-client';
import { DiscountField, INPUT_CLASS, TABLE_HEAD_CELL } from './DiscountField';

type ListData = { total: number; rows: DiscountListRow[] };
type Applied = { status: DiscountListStatus | ''; kind: DiscountKind | ''; method: DiscountMethod | ''; query: string };
type State =
  | { phase: 'loading'; previous: ListData | null }
  | { phase: 'error'; message: string; forbidden: boolean }
  | { phase: 'ready'; data: ListData };

const COLUMNS = ['割引名', '種類', '効き方', '状態', '期間', '使った回数', '上限'] as const;
const EMPTY_FILTERS: Applied = { status: '', kind: '', method: '', query: '' };

function isListData(value: unknown): value is ListData {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Record<string, unknown>;
  return typeof data.total === 'number' && Array.isArray(data.rows);
}

function listQuery(filters: Applied, page: number): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.method) params.set('method', filters.method);
  if (filters.query) params.set('query', filters.query);
  if (page > 1) params.set('page', String(page));
  return params.toString();
}

export default function DiscountList({ onOpen, onCreate }: { onOpen: (id: string) => void; onCreate: () => void }): React.JSX.Element {
  const [filters, setFilters] = useState<Applied>(EMPTY_FILTERS);
  const [searchDraft, setSearchDraft] = useState('');
  const [page, setPage] = useState(1);
  const [state, setState] = useState<State>({ phase: 'loading', previous: null });
  const [permissions, setPermissions] = useState<DiscountPermissions | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async (applied: Applied, nextPage: number): Promise<void> => {
    const requestId = ++requestSeq.current;
    const isLatest = () => requestId === requestSeq.current;
    setState((current) => ({ phase: 'loading', previous: current.phase === 'ready' ? current.data : current.phase === 'loading' ? current.previous : null }));
    try {
      const query = listQuery(applied, nextPage);
      const response = await clientFetch(`/api/admin/discounts${query ? `?${query}` : ''}`, { cache: 'no-store' });
      if (!response.ok) {
        const failure = await readDiscountFailure(response, DISCOUNT_TEXT.listFailed, DISCOUNT_TEXT.listForbidden);
        if (isLatest()) setState({ phase: 'error', message: failure.message, forbidden: failure.status === 403 });
        return;
      }
      const json = (await response.json()) as { data?: unknown; permissions?: Partial<DiscountPermissions> };
      if (!isLatest()) return;
      if (!isListData(json.data)) {
        setState({ phase: 'error', message: DISCOUNT_TEXT.listFailed, forbidden: false });
        return;
      }
      setPermissions({ read: json.permissions?.read === true, manage: json.permissions?.manage === true });
      setState({ phase: 'ready', data: json.data });
    } catch (error) {
      console.error('Failed to fetch admin discounts:', error instanceof Error ? error.name : 'UnknownError');
      if (isLatest()) setState({ phase: 'error', message: DISCOUNT_TEXT.listFailed, forbidden: false });
    }
  }, []);

  useEffect(() => {
    void load(filters, page);
    return () => { requestSeq.current += 1; };
  }, [load, filters, page]);

  const changeFilter = (patch: Partial<Applied>): void => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
  };
  const handleSearch = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    changeFilter({ query: searchDraft.trim() });
  };

  const data = state.phase === 'ready' ? state.data : state.phase === 'loading' ? state.previous : null;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / DISCOUNT_PAGE_SIZE)) : 1;

  return (
    <section aria-label="割引" className="w-full min-w-0 max-w-full space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="lk-text-xl">{DISCOUNT_TEXT.title}</h2>
        {permissions?.manage ? <Button size="sm" className="font-acumin" onClick={onCreate}>{DISCOUNT_TEXT.create}</Button> : null}
      </div>

      {state.phase === 'error' ? (
        <div className="space-y-3">
          <p role="alert" className="lk-text-sm text-red-700 font-acumin">{state.message}</p>
          {state.forbidden ? null : <Button variant="secondary" size="sm" className="font-acumin" onClick={() => void load(filters, page)}>{DISCOUNT_TEXT.reload}</Button>}
        </div>
      ) : null}

      {state.phase === 'error' && state.forbidden ? null : (
        <>
          <div className="grid min-w-0 gap-3 sm:grid-cols-3">
            <DiscountField label="状態">
              {(props) => (
                <select {...props} className={INPUT_CLASS} value={filters.status} onChange={(event) => changeFilter({ status: event.target.value as Applied['status'] })}>
                  <option value="">すべて</option>
                  {STATUS_ORDER.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}
                </select>
              )}
            </DiscountField>
            <DiscountField label="種類">
              {(props) => (
                <select {...props} className={INPUT_CLASS} value={filters.kind} onChange={(event) => changeFilter({ kind: event.target.value as Applied['kind'] })}>
                  <option value="">すべて</option>
                  {KIND_ORDER.map((kind) => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}
                </select>
              )}
            </DiscountField>
            <DiscountField label="効き方">
              {(props) => (
                <select {...props} className={INPUT_CLASS} value={filters.method} onChange={(event) => changeFilter({ method: event.target.value as Applied['method'] })}>
                  <option value="">すべて</option>
                  <option value="code">{METHOD_LABELS.code}</option>
                  <option value="automatic">{METHOD_LABELS.automatic}</option>
                </select>
              )}
            </DiscountField>
          </div>
          <form aria-label="割引を探す" onSubmit={handleSearch} className="flex min-w-0 flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 basis-64">
              <DiscountField label="名前・コードで探す">
                {(props) => <input {...props} type="text" maxLength={100} className={INPUT_CLASS} value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} />}
              </DiscountField>
            </div>
            <Button type="submit" variant="secondary" size="sm" className="font-acumin">探す</Button>
          </form>
        </>
      )}

      {state.phase === 'loading' ? <p role="status" className="lk-text-sm text-[#474747] font-acumin">{DISCOUNT_TEXT.loading}</p> : null}

      {data ? (
        <div aria-busy={state.phase === 'loading'} className={state.phase === 'loading' ? 'space-y-3 opacity-60' : 'space-y-3'}>
          <p data-testid="discount-count" className="lk-text-sm font-acumin">{data.total}件</p>
          {data.rows.length === 0 ? (
            <p className="lk-text-sm text-[#474747] font-acumin">{DISCOUNT_TEXT.empty}</p>
          ) : (
            <div role="region" aria-label="割引の一覧" tabIndex={0} className="max-h-[70vh] w-full min-w-0 max-w-full overflow-auto border border-black/15 focus-visible:outline-2">
              <table className="w-full min-w-[56rem] border-collapse text-left lk-text-2xs">
                <thead>
                  <tr>{COLUMNS.map((column) => <th key={column} scope="col" className={TABLE_HEAD_CELL}>{column}</th>)}</tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.id} className="border-b border-black/10 align-top">
                      <td className="break-words p-3">
                        <button type="button" className="text-left underline underline-offset-4" onClick={() => onOpen(row.id)}>{row.name}</button>
                        {row.searchAttention ? (
                          <p className="mt-1 lk-text-3xs text-red-700">
                            要対応 {DISCOUNT_TEXT.attention}（{row.searchAttention.count}件）
                          </p>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap p-3">{KIND_LABELS[row.kind]}</td>
                      <td className="whitespace-nowrap p-3">{METHOD_LABELS[row.method]}</td>
                      <td className="whitespace-nowrap p-3">{STATUS_LABELS[row.status]}</td>
                      <td className="whitespace-nowrap p-3">{formatJst(row.startsAt)} 〜 {row.endsAt === null ? '無期限' : formatJst(row.endsAt)}</td>
                      <td className="whitespace-nowrap p-3 text-right tabular-nums">{row.usedCount}</td>
                      <td className="whitespace-nowrap p-3 text-right tabular-nums">{row.usageLimit === null ? '上限なし' : row.usageLimit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3 lk-text-3xs font-acumin">
            <Button variant="secondary" size="sm" className="font-acumin" disabled={page <= 1} onClick={() => setPage(page - 1)}>前の頁</Button>
            <span className="tabular-nums">{page} / {totalPages}ページ</span>
            <Button variant="secondary" size="sm" className="font-acumin" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>次の頁</Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
