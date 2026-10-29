// File: src/features/discounts/components/DiscountField.tsx
// 割引の管理画面の入力欄の枠。label は htmlFor で結ぶ（欄の名前に選択肢や入力中の文字が混ざらない）。
// 説明（hint）と誤り（error）は aria-describedby で欄へ結ぶ。
import { useId, type ReactNode } from 'react';

export const INPUT_CLASS = 'w-full min-w-0 border border-black/30 bg-white px-3 py-2 lk-text-sm font-acumin disabled:bg-black/5 disabled:text-[#474747]';
export const TABLE_HEAD_CELL = 'sticky top-0 z-10 whitespace-nowrap border-b border-black/15 bg-white p-3 text-left font-normal';

type ControlProps = { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true };

export function DiscountField({ label, hint, error, children }: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (props: ControlProps) => ReactNode;
}): React.JSX.Element {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={id} className="block lk-text-3xs font-acumin">{label}</label>
      {children({ id, ...(describedBy ? { 'aria-describedby': describedBy } : {}), ...(error ? { 'aria-invalid': true as const } : {}) })}
      {hint ? <p id={hintId} className="lk-text-3xs text-[#474747] font-acumin">{hint}</p> : null}
      {error ? <p id={errorId} className="lk-text-3xs text-red-700 font-acumin">{error}</p> : null}
    </div>
  );
}

/** チェック欄。label が欄を包むので、名前は文言そのまま */
export function DiscountCheckbox({ label, hint, error, checked, disabled, onChange }: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}): React.JSX.Element {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ');
  return (
    <div className="min-w-0 space-y-1">
      <label className="flex items-start gap-2 lk-text-sm font-acumin">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={describedBy || undefined}
          aria-invalid={error ? true : undefined}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-1"
        />
        <span>{label}</span>
      </label>
      {hint ? <p id={`${id}-hint`} className="pl-6 lk-text-3xs text-[#474747] font-acumin">{hint}</p> : null}
      {error ? <p id={`${id}-error`} className="pl-6 lk-text-3xs text-red-700 font-acumin">{error}</p> : null}
    </div>
  );
}
