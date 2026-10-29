'use client';

// File: src/features/discounts/components/DiscountItemChooser.tsx
// 割引の対象（または除く）服を選ぶ欄。服の一覧は /api/admin/items（admin.items.read）から1回読む。
// 読めなかった時も、選んでいる服は番号で見せて外せる。非 ok の本文は読み切ってから文を出す。
import { useCallback, useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { clientFetch } from '@/lib/client-fetch';
import { readDiscountFailure } from '../discount-admin-client';
import { DiscountField, INPUT_CLASS } from './DiscountField';

type ItemOption = { id: number; name: string };
const ITEMS_FAILED = '服の一覧を読み込めませんでした。';
const ITEMS_FORBIDDEN = '服の一覧を見る権限がありません。';

function toOptions(value: unknown): ItemOption[] | null {
  if (!Array.isArray(value)) return null;
  const options: ItemOption[] = [];
  for (const entry of value) {
    const item = entry as { id?: unknown; name?: unknown } | null;
    const id = Number(item?.id);
    if (Number.isSafeInteger(id) && id >= 1 && typeof item?.name === 'string') options.push({ id, name: item.name });
  }
  return options;
}

export default function DiscountItemChooser({ legend, selected, onChange, disabled, error, hint }: {
  legend: string;
  selected: readonly number[];
  onChange: (itemIds: number[]) => void;
  disabled?: boolean;
  error?: string | null;
  hint?: string;
}): React.JSX.Element {
  const errorId = useId();
  const [options, setOptions] = useState<ItemOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      const response = await clientFetch('/api/admin/items', { cache: 'no-store' });
      if (!response.ok) {
        setLoadError((await readDiscountFailure(response, ITEMS_FAILED, ITEMS_FORBIDDEN)).message);
        return;
      }
      const json = (await response.json()) as { data?: unknown };
      const parsed = toOptions(json.data);
      if (parsed) setOptions(parsed); else setLoadError(ITEMS_FAILED);
    } catch (caught) {
      console.error('Failed to fetch items for discount:', caught instanceof Error ? caught.name : 'UnknownError');
      setLoadError(ITEMS_FAILED);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (id: number): void => {
    onChange(selected.includes(id) ? selected.filter((candidate) => candidate !== id) : [...selected, id]);
  };
  const needle = filter.trim().toLowerCase();
  const visible = (options ?? []).filter((option) => needle === '' || option.name.toLowerCase().includes(needle));
  const known = new Set((options ?? []).map((option) => option.id));
  const orphans = selected.filter((id) => !known.has(id));

  return (
    <fieldset className="min-w-0 space-y-2" aria-describedby={error ? errorId : undefined}>
      <legend className="lk-text-3xs font-acumin">{legend}</legend>
      {hint ? <p className="lk-text-3xs text-[#474747] font-acumin">{hint}</p> : null}
      <p className="lk-text-3xs font-acumin">選んだ服 {selected.length}点</p>
      {loadError ? (
        <div className="space-y-2">
          <p role="alert" className="lk-text-sm text-red-700 font-acumin">{loadError}</p>
          <Button variant="secondary" size="sm" className="font-acumin" onClick={() => void load()}>読み直す</Button>
        </div>
      ) : null}
      {options ? (
        <DiscountField label="服を絞り込む">
          {(props) => <input {...props} type="text" aria-invalid={error && visible.length === 0 && orphans.length === 0 ? true : undefined} aria-describedby={error ? errorId : undefined} className={INPUT_CLASS} value={filter} onChange={(event) => setFilter(event.target.value)} />}
        </DiscountField>
      ) : null}
      <div className="max-h-56 space-y-1 overflow-auto border border-black/15 p-2">
        {orphans.map((id) => (
          <label key={`orphan-${id}`} className="flex items-start gap-2 lk-text-sm font-acumin">
            <input type="checkbox" aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} checked disabled={disabled} onChange={() => toggle(id)} className="mt-1" />
            <span>商品番号 {id}</span>
          </label>
        ))}
        {visible.map((option) => (
          <label key={option.id} className="flex items-start gap-2 lk-text-sm font-acumin">
            <input type="checkbox" aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} checked={selected.includes(option.id)} disabled={disabled} onChange={() => toggle(option.id)} className="mt-1" />
            <span className="min-w-0 break-words">{option.name}</span>
          </label>
        ))}
        {options && visible.length === 0 && orphans.length === 0 ? <p className="lk-text-3xs text-[#474747] font-acumin">該当する服はありません。</p> : null}
        {!options && !loadError ? <p role="status" className="lk-text-3xs text-[#474747] font-acumin">読み込み中…</p> : null}
      </div>
      {error ? <p id={errorId} className="lk-text-3xs text-red-700 font-acumin">{error}</p> : null}
    </fieldset>
  );
}
