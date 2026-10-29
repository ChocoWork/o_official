'use client';

// File: src/features/discounts/components/DiscountForm.tsx
// 割引を作る・変えるフォーム（グループ H / FREQ-547-AC-02・AC-04）。種類ごとに欄を出し分ける。
// 使った後（initial.used）は名前・期間・回数の上限・前もって知らせる・案内文（C12）だけ編集でき、ほかは disabled。
// disabled だけに頼らず、窓口と DB が同じ規則で断る。検査は欄ごとに誤りを結び、保存の失敗は live region に出す。
// セットの最大組数・部分組数を選ぶ欄は作らない（C22）。
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { clientFetch } from '@/lib/client-fetch';
import type { AdminDiscountDetail, DiscountCreateInput, DiscountMember } from '@/lib/discounts/admin-discount-types';
import { MAX_DISCOUNT_BATCH, type DiscountKind, type DiscountMethod } from '@/lib/discounts/discount-types';
import {
  DISCOUNT_TEXT, KIND_LABELS, KIND_ORDER, assignmentMode, createRequestKeys, drainBody, isoToJstLocal, jstLocalToIso, readDiscountFailure,
  type DiscountFailure,
} from '../discount-admin-client';
import { DiscountCheckbox, DiscountField, INPUT_CLASS } from './DiscountField';
import DiscountItemChooser from './DiscountItemChooser';
import DiscountMemberPicker from './DiscountMemberPicker';

type FieldKey =
  | 'name' | 'code' | 'prefix' | 'count' | 'members' | 'value' | 'minimum' | 'items' | 'repeat'
  | 'audience' | 'usageLimit' | 'startsAt' | 'endsAt' | 'combine' | 'method' | 'advertisingText';
type Errors = Partial<Record<FieldKey, string>>;

type FormState = {
  name: string; kind: DiscountKind; method: DiscountMethod; codeMode: 'shared' | 'batch'; code: string;
  valueType: 'percent' | 'amount'; valueText: string; targetMode: 'all' | 'exclude' | 'include'; itemIds: number[];
  minimumType: 'none' | 'amount' | 'quantity'; minimumText: string;
  audience: 'assigned' | 'anyone'; allowGuests: boolean; firstOrderOnly: boolean;
  usageLimitText: string; oncePerCustomer: boolean; startsAt: string; endsAt: string;
  combinesWithProduct: boolean; combinesWithOrder: boolean; advertise: boolean; advertisingText: string;
  repeatPrevious: boolean; repeatInOrder: boolean;
  prefix: string; countText: string; members: DiscountMember[];
};

type PatchKey = Exclude<keyof DiscountCreateInput, 'code' | 'codeMode' | 'stopped' | 'initialBatch'>;
/** 使った後も変えられる欄（C12）。窓口と DB も同じ集合だけを通す */
const EDITABLE_AFTER_USE: ReadonlySet<PatchKey> = new Set<PatchKey>(['name', 'startsAt', 'endsAt', 'usageLimit', 'advertise', 'advertisingText']);
const PATCH_KEYS: readonly PatchKey[] = [
  'name', 'kind', 'method', 'value', 'targetMode', 'itemIds', 'minimum', 'audience', 'allowGuests', 'firstOrderOnly', 'usageLimit',
  'oncePerCustomer', 'startsAt', 'endsAt', 'combinesWithProduct', 'combinesWithOrder', 'advertise', 'advertisingText', 'repeatPrevious', 'repeatInOrder',
];
const CODE_PATTERN = /^[A-Z0-9-]{1,64}$/;
const PREFIX_PATTERN = /^[A-Z0-9]([A-Z0-9-]{0,53}[A-Z0-9])?$/;
const SAVE_FAILED = '保存できませんでした。';
const SET_CONFLICT_TEXT = '同じ服を含むセット割引は、同じ期間に重ねる設定にできません。';

/** 深さを問わずキーの順をそろえて文字にする（保存済みの値との比べ用） */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map((entry) => JSON.parse(canonical(entry)) as unknown));
  if (value !== null && typeof value === 'object') {
    return JSON.stringify(Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, JSON.parse(canonical(v)) as unknown])));
  }
  return JSON.stringify(value ?? null);
}

const toInt = (text: string): number => (/^[0-9]+$/.test(text.trim()) ? Number(text.trim()) : Number.NaN);
const upper = (text: string): string => text.trim().toUpperCase();

function nowLocal(): string {
  return isoToJstLocal(new Date(Math.floor(Date.now() / 60000) * 60000).toISOString());
}

function emptyState(): FormState {
  return {
    name: '', kind: 'order_percent', method: 'code', codeMode: 'shared', code: '',
    valueType: 'percent', valueText: '10', targetMode: 'all', itemIds: [],
    minimumType: 'none', minimumText: '',
    audience: 'anyone', allowGuests: false, firstOrderOnly: false,
    usageLimitText: '', oncePerCustomer: false, startsAt: nowLocal(), endsAt: '',
    combinesWithProduct: false, combinesWithOrder: false, advertise: false, advertisingText: '',
    repeatPrevious: false, repeatInOrder: false, prefix: '', countText: '1', members: [],
  };
}

function stateFromDetail(detail: AdminDiscountDetail): FormState {
  const d = detail.discount;
  return {
    name: d.name, kind: d.kind, method: d.method, codeMode: detail.codes.length > 0 && assignmentMode(detail.codes).mode === 'batch' ? 'batch' : 'shared', code: detail.codes.find((code) => !code.singleUse)?.code ?? '',
    valueType: d.value.type, valueText: String(d.value.value), targetMode: d.targetMode, itemIds: [...d.itemIds],
    minimumType: d.minimum.type, minimumText: d.minimum.type === 'none' ? '' : String(d.minimum.value),
    audience: d.audience, allowGuests: d.allowGuests, firstOrderOnly: d.firstOrderOnly,
    usageLimitText: d.usageLimit === null ? '' : String(d.usageLimit), oncePerCustomer: d.oncePerCustomer,
    startsAt: isoToJstLocal(d.startsAt), endsAt: isoToJstLocal(d.endsAt),
    combinesWithProduct: d.combinesWithProduct, combinesWithOrder: d.combinesWithOrder,
    advertise: d.advertise, advertisingText: d.advertisingText ?? '',
    repeatPrevious: d.repeatPrevious, repeatInOrder: d.repeatInOrder, prefix: '', countText: '1', members: [],
  };
}

/** 画面の値を窓口の入力の形にする。種類や効き方で意味の無い欄は、窓口の規則に合う固定値へ直す */
function buildInput(s: FormState): DiscountCreateInput {
  const automatic = s.method === 'automatic';
  const valueType = s.kind === 'order_percent' ? 'percent' : s.kind === 'order_amount' ? 'amount' : s.valueType;
  const orderKind = s.kind === 'order_percent' || s.kind === 'order_amount';
  const targetMode = orderKind ? 'all' : s.kind === 'product' ? (s.targetMode === 'exclude' ? 'exclude' : 'all') : 'include';
  const audience = automatic ? 'anyone' : s.audience;
  const advertise = automatic && s.advertise;
  const minimumValue = toInt(s.minimumText);
  const usageLimit = s.usageLimitText.trim() === '' ? null : toInt(s.usageLimitText);
  return {
    name: s.name.trim(), kind: s.kind, method: s.method,
    value: { type: valueType, value: toInt(s.valueText) },
    targetMode, itemIds: targetMode === 'all' ? [] : [...s.itemIds].sort((a, b) => a - b),
    minimum: s.minimumType === 'none' ? { type: 'none', value: 0 } : { type: s.minimumType, value: minimumValue },
    audience, allowGuests: automatic ? true : audience === 'assigned' ? false : s.allowGuests,
    firstOrderOnly: s.firstOrderOnly, usageLimit, oncePerCustomer: s.oncePerCustomer,
    startsAt: jstLocalToIso(s.startsAt) ?? '', endsAt: s.endsAt === '' ? null : (jstLocalToIso(s.endsAt) ?? ''),
    stopped: false, combinesWithProduct: s.combinesWithProduct, combinesWithOrder: s.combinesWithOrder,
    advertise, advertisingText: advertise ? s.advertisingText.trim() : null,
    repeatPrevious: s.kind === 'repeat' && s.repeatPrevious, repeatInOrder: s.kind === 'repeat' && s.repeatInOrder,
    code: !automatic && s.codeMode === 'shared' && s.code.trim() !== '' ? upper(s.code) : null,
    codeMode: s.codeMode,
  };
}

function validate(s: FormState, o: { creating: boolean; used: boolean; showCode: boolean; initial: AdminDiscountDetail | null }): Errors {
  const e: Errors = {};
  if (s.name.trim() === '') e.name = '割引の名前を入力してください。';
  else if (s.name.trim().length > 100) e.name = '割引の名前は100字までです。';
  const limit = s.usageLimitText.trim();
  if (limit !== '' && !(toInt(limit) >= 1 && toInt(limit) <= 2147483647)) e.usageLimit = '回数の上限は1以上の整数で入力してください。';
  const original = o.initial?.discount;
  const startIso = original && s.startsAt === isoToJstLocal(original.startsAt) ? original.startsAt : jstLocalToIso(s.startsAt);
  const endIso = original && s.endsAt === isoToJstLocal(original.endsAt) ? original.endsAt : s.endsAt === '' ? null : jstLocalToIso(s.endsAt);
  if (startIso === null) e.startsAt = '開始の日時を入力してください。';
  if (s.endsAt !== '' && endIso === null) e.endsAt = '終了の日時を確かめてください。';
  else if (startIso !== null && endIso !== null && Date.parse(endIso) <= Date.parse(startIso)) e.endsAt = '終了は開始より後にしてください。';
  if (s.method === 'automatic' && s.advertise && s.advertisingText.trim() === '') e.advertisingText = '案内文を入力してください。';
  if (o.used) return e;

  const input = buildInput(s);
  if (input.value.type === 'percent') {
    if (!(input.value.value >= 1 && input.value.value <= 99)) e.value = '割引率は1〜99の整数で入力してください。';
  } else if (!(input.value.value >= 1 && input.value.value <= 2147483647)) {
    e.value = '割引額は1円以上の整数で入力してください。';
  }
  if (s.minimumType !== 'none' && !(input.minimum.value >= 1 && input.minimum.value <= 2147483647)) {
    e.minimum = s.minimumType === 'amount' ? '最低金額は1円以上の整数で入力してください。' : '最低点数は1以上の整数で入力してください。';
  } else if (input.value.type === 'amount') {
    if (input.minimum.type !== 'amount') e.minimum = '円引きには最低金額が必要です。';
    else if (!(input.minimum.value > input.value.value)) e.minimum = '最低金額は割引額より大きくしてください。';
  }
  if (s.kind === 'set' && (s.itemIds.length < 2 || s.itemIds.length > 10)) e.items = 'セット割引には、服を2〜10点選んでください。';
  if (s.kind === 'repeat') {
    if (s.itemIds.length < 1) e.items = '対象の服を1点以上選んでください。';
    if (!s.repeatPrevious && !s.repeatInOrder) e.repeat = 'AかBのどちらかを選んでください。';
  }
  if (o.creating && s.method === 'code') {
    if (s.codeMode === 'shared') {
      if (!CODE_PATTERN.test(upper(s.code))) e.code = 'コードは英数字とハイフンの1〜64字で入力してください。';
    } else {
      if (!PREFIX_PATTERN.test(upper(s.prefix))) e.prefix = 'コードの先頭の文字は、英数字とハイフンの1〜55字で入力してください。';
      const count = s.members.length > 0 ? s.members.length : toInt(s.countText);
      if (!(count >= 1 && count <= MAX_DISCOUNT_BATCH)) e.count = `束の個数は1〜${MAX_DISCOUNT_BATCH}で入力してください。`;
      if (s.audience === 'assigned' && s.members.length === 0) e.audience = '割り当てた人だけの束には会員を選んでください。';
      if (s.audience === 'anyone' && s.members.length > 0) e.audience = '会員を選んだ束は、使える人を「割り当てた人だけ」にしてください。';
    }
  }
  if (!o.creating && o.showCode && s.code.trim() !== '' && !CODE_PATTERN.test(upper(s.code))) e.code = 'コードは英数字とハイフンの1〜64字で入力してください。';
  return e;
}

/** 窓口の固定コードから、結ぶ欄を決める。欄の無い失敗は全体の live region に出す */
function fieldOfFailure(failure: DiscountFailure, batchStep: boolean): FieldKey | null {
  switch (failure.code) {
    case 'GROUP_H_CODE_CONFLICT': return batchStep ? 'prefix' : 'code';
    case 'GROUP_H_AUTOMATIC_LIMIT': return 'method';
    case 'GROUP_H_STACKABLE_AUTOMATIC_LIMIT':
    case 'GROUP_H_STACKABLE_SET_ITEM_CONFLICT': return 'combine';
    default: return null;
  }
}

export default function DiscountForm({ initial, onSaved }: { initial: AdminDiscountDetail | null; onSaved: (id: string) => void }): React.JSX.Element {
  const creating = initial === null;
  const used = initial?.used === true;
  const batchRows = initial ? initial.codes.some((code) => code.singleUse) && assignmentMode(initial.codes).mode === 'batch' : false;
  const showCode = !creating && initial?.discount.method === 'code' && !batchRows;
  const [state, setState] = useState<FormState>(() => (initial ? stateFromDetail(initial) : emptyState()));
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const keys = useRef(createRequestKeys());
  const formRef = useRef<HTMLFormElement>(null);

  const set = (patch: Partial<FormState>): void => {
    setState((current) => ({ ...current, ...patch }));
  };
  const changeKind = (kind: DiscountKind): void => {
    setState((current) => {
      const next: Partial<FormState> = { kind };
      if (kind === 'order_percent') Object.assign(next, { valueType: 'percent', targetMode: 'all', itemIds: [] });
      else if (kind === 'order_amount') Object.assign(next, { valueType: 'amount', targetMode: 'all', itemIds: [], minimumType: 'amount' });
      else if (kind === 'product') Object.assign(next, { targetMode: current.targetMode === 'exclude' ? 'exclude' : 'all', itemIds: current.targetMode === 'exclude' ? current.itemIds : [] });
      else Object.assign(next, { targetMode: 'include', itemIds: current.targetMode === 'include' ? current.itemIds : [] });
      if (kind === 'repeat' && !current.repeatPrevious && !current.repeatInOrder) next.repeatInOrder = true;
      if (kind === 'set' && creating) Object.assign(next, { method: 'automatic', audience: 'anyone', allowGuests: true, codeMode: 'shared', code: '' });
      return { ...current, ...next };
    });
  };
  const changeMethod = (method: DiscountMethod): void => {
    set(method === 'automatic'
      ? { method, audience: 'anyone', allowGuests: true, codeMode: 'shared', code: '', members: [] }
      : { method, allowGuests: false, advertise: false });
  };
  const changeValueType = (valueType: 'percent' | 'amount'): void => {
    set(valueType === 'amount' ? { valueType, minimumType: 'amount' } : { valueType });
  };
  const changeAudience = (audience: 'assigned' | 'anyone'): void => {
    set(audience === 'assigned' ? { audience, allowGuests: false } : { audience });
  };

  const input = buildInput(state);
  const lock = used;
  const orderKind = state.kind === 'order_percent' || state.kind === 'order_amount';
  const amountValue = input.value.type === 'amount';
  const needsItems = state.kind === 'repeat' || state.kind === 'set' || (state.kind === 'product' && state.targetMode === 'exclude');
  const automatic = state.method === 'automatic';
  const perUnit = state.kind === 'set' ? '1組あたり' : state.kind === 'order_percent' || state.kind === 'order_amount' ? '' : '1着あたり';

  const focusFirstInvalid = (): void => {
    const target = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    target?.focus();
  };

  const saveEdit = async (current: AdminDiscountDetail): Promise<void> => {
    const built = buildInput(state);
    const patch: Record<string, unknown> = {};
    for (const key of PATCH_KEYS) {
      if (used && !EDITABLE_AFTER_USE.has(key)) continue;
      const before = current.discount[key as keyof typeof current.discount];
      const after = built[key];
      if (key === 'startsAt' || key === 'endsAt') {
        // The minute input cannot represent DB seconds/microseconds. Preserve them until the user changes the displayed minute.
        if (state[key] === isoToJstLocal(current.discount[key])) continue;
        if (before === null || after === null) { if (before !== after) patch[key] = after; }
        else if (Date.parse(String(before)) !== Date.parse(String(after))) patch[key] = after;
      } else if (key === 'itemIds') {
        if (canonical([...current.discount.itemIds].sort((a, b) => a - b)) !== canonical(after)) patch[key] = after;
      } else if (canonical(before) !== canonical(after)) patch[key] = after;
    }
    if (showCode && !used && state.code.trim() !== '' && upper(state.code) !== current.codes.find((code) => !code.singleUse)?.code) patch.code = upper(state.code);
    if (Object.keys(patch).length === 0) { setFormError('変更はありません。'); return; }
    const body = { patch, expectedVersion: current.discount.version };
    const signature = JSON.stringify(body);
    const response = await clientFetch(`/api/admin/discounts/${current.discount.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, requestKey: keys.current.keyFor(signature) }),
    });
    if (!response.ok) { await fail(await readDiscountFailure(response, SAVE_FAILED, DISCOUNT_TEXT.manageForbidden), false); return; }
    await drainBody(response);
    keys.current.done(signature);
    onSaved(current.discount.id);
  };

  const fail = async (failure: DiscountFailure, batchStep: boolean): Promise<void> => {
    const field = fieldOfFailure(failure, batchStep);
    if (field) {
      const message = failure.code === 'GROUP_H_STACKABLE_SET_ITEM_CONFLICT' ? SET_CONFLICT_TEXT : failure.message;
      setErrors({ [field]: message });
      setFormError(SAVE_FAILED);
    } else {
      setFormError(failure.message);
    }
  };

  const saveCreate = async (): Promise<void> => {
    const built = buildInput(state);
    const batch = built.method === 'code' && built.codeMode === 'batch';
    if (batch) built.initialBatch = {
      prefix: upper(state.prefix), userIds: state.members.map((member) => member.userId).sort(),
      count: state.members.length > 0 ? state.members.length : toInt(state.countText),
    };
    const signature = JSON.stringify(built);
    const response = await clientFetch('/api/admin/discounts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: built, requestKey: keys.current.keyFor(signature) }),
    });
    if (!response.ok) { await fail(await readDiscountFailure(response, SAVE_FAILED, DISCOUNT_TEXT.manageForbidden), batch); return; }
    const json = (await response.json()) as { data?: { discountId?: unknown } };
    if (typeof json.data?.discountId !== 'string') { setFormError(SAVE_FAILED); return; }
    const discountId = json.data.discountId;
    keys.current.done(signature);
    onSaved(discountId);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submittingRef.current) return;
    const found = validate(state, { creating, used, showCode, initial });
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setFormError(DISCOUNT_TEXT.invalid);
      setTimeout(focusFirstInvalid, 0);
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setFormError(null);
    try {
      if (initial) await saveEdit(initial); else await saveCreate();
    } catch (caught) {
      console.error('Failed to save admin discount:', caught instanceof Error ? caught.name : 'UnknownError');
      setFormError(SAVE_FAILED);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <form ref={formRef} aria-label={creating ? '割引を作る' : '割引を変える'} noValidate onSubmit={(event) => void handleSubmit(event)} className="w-full min-w-0 max-w-3xl space-y-6">
      {lock ? <p className="lk-text-sm text-[#474747] font-acumin">{DISCOUNT_TEXT.usedNote}</p> : null}
      {formError ? <p role="alert" className="lk-text-sm text-red-700 font-acumin">{formError}</p> : null}


      <DiscountField label="割引の名前" error={errors.name}>
        {(props) => <input {...props} type="text" maxLength={120} className={INPUT_CLASS} value={state.name} onChange={(event) => set({ name: event.target.value })} />}
      </DiscountField>

      <DiscountField label="割引の種類">
        {(props) => (
          <select {...props} className={INPUT_CLASS} value={state.kind} disabled={lock} onChange={(event) => changeKind(event.target.value as DiscountKind)}>
            {KIND_ORDER.map((kind) => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}
          </select>
        )}
      </DiscountField>

      <DiscountField label="効き方" error={errors.method} hint="コードは入力した人に、自動は条件に合う注文に効きます。">
        {(props) => (
          <select {...props} className={INPUT_CLASS} value={state.method} disabled={lock} onChange={(event) => changeMethod(event.target.value as DiscountMethod)}>
            <option value="code">コード</option>
            <option value="automatic">自動</option>
          </select>
        )}
      </DiscountField>

      {state.method === 'code' && creating ? (
        <DiscountField label="コードの作り方">
          {(props) => (
            <select {...props} className={INPUT_CLASS} value={state.codeMode} onChange={(event) => set({ codeMode: event.target.value as 'shared' | 'batch' })}>
              <option value="shared">共有コード（1つのコードを使う）</option>
              <option value="batch">使い捨てコードの束</option>
            </select>
          )}
        </DiscountField>
      ) : null}

      {state.method === 'code' && state.codeMode === 'shared' && (creating || showCode) ? (
        <DiscountField
          label="コード"
          error={errors.code}
          hint={creating ? '英数字とハイフンの1〜64字。大文字・小文字は区別しません。' : '今のコードです。変えるときは入力し直してください。'}
        >
          {(props) => <input {...props} type="text" maxLength={64} autoComplete="off" className={INPUT_CLASS} value={state.code} disabled={lock} onChange={(event) => set({ code: event.target.value })} />}
        </DiscountField>
      ) : null}

      {state.method === 'code' && state.codeMode === 'batch' && creating ? (
        <div className="space-y-4">
          <DiscountField
            label="コードの先頭の文字"
            error={errors.prefix}
            hint={PREFIX_PATTERN.test(upper(state.prefix))
              ? `コードは「${upper(state.prefix)}-」に4〜8文字が続く形になります。先頭の文字だけでは使えません。`
              : '英数字とハイフンで入力します。コードは先頭の文字、ハイフン、4〜8文字の英数字の形になります。'}
          >
            {(props) => <input {...props} type="text" maxLength={55} autoComplete="off" className={INPUT_CLASS} value={state.prefix} onChange={(event) => set({ prefix: event.target.value })} />}
          </DiscountField>
          <DiscountField label="束の個数" error={errors.count} hint={`1〜${MAX_DISCOUNT_BATCH}個。会員を選ぶと、選んだ人数になります。`}>
            {(props) => (
              <input
                {...props} type="text" inputMode="numeric" className={INPUT_CLASS}
                value={state.members.length > 0 ? String(state.members.length) : state.countText}
                disabled={state.members.length > 0}
                onChange={(event) => set({ countText: event.target.value })}
              />
            )}
          </DiscountField>
          <div className="space-y-2">
            <p className="lk-text-3xs font-acumin">割り当てる会員（選ばなければ、誰でも使えるコードを作ります）</p>
            <DiscountMemberPicker selected={state.members} onChange={(members) => set({ members })} />
          </div>
        </div>
      ) : null}

      {!orderKind ? (
        <DiscountField label="割引の方法">
          {(props) => (
            <select {...props} className={INPUT_CLASS} value={state.valueType} disabled={lock} onChange={(event) => changeValueType(event.target.value as 'percent' | 'amount')}>
              <option value="percent">率（％）</option>
              <option value="amount">額（円）</option>
            </select>
          )}
        </DiscountField>
      ) : null}
      <DiscountField
        label={amountValue ? '割引額（円）' : '割引率（％）'}
        error={errors.value}
        hint={`${perUnit}${amountValue ? '何円引くかを入力します。' : '何％引くかを1〜99で入力します。'}`}
      >
        {(props) => <input {...props} type="text" inputMode="numeric" className={INPUT_CLASS} value={state.valueText} disabled={lock} onChange={(event) => set({ valueText: event.target.value })} />}
      </DiscountField>

      {state.kind === 'product' ? (
        <DiscountField label="対象の服">
          {(props) => (
            <select {...props} className={INPUT_CLASS} value={state.targetMode === 'exclude' ? 'exclude' : 'all'} disabled={lock} onChange={(event) => set({ targetMode: event.target.value as 'all' | 'exclude', itemIds: event.target.value === 'all' ? [] : state.itemIds })}>
              <option value="all">すべての服</option>
              <option value="exclude">選んだ服を除く</option>
            </select>
          )}
        </DiscountField>
      ) : null}
      {needsItems ? (
        <DiscountItemChooser
          legend={state.kind === 'product' ? '除く服' : state.kind === 'set' ? 'セットにする服（2〜10点、各1着）' : '対象の服'}
          selected={state.itemIds}
          onChange={(itemIds) => set({ itemIds })}
          disabled={lock}
          error={errors.items}
        />
      ) : null}

      {state.kind === 'repeat' ? (
        <fieldset className="min-w-0 space-y-2">
          <legend className="lk-text-3xs font-acumin">リピートの数え方</legend>
          <DiscountCheckbox label="A: 前の注文で買った服も数える" error={errors.repeat} checked={state.repeatPrevious} disabled={lock} onChange={(repeatPrevious) => set({ repeatPrevious })} />
          <DiscountCheckbox label="B: 同じ注文の2着目から" checked={state.repeatInOrder} disabled={lock} onChange={(repeatInOrder) => set({ repeatInOrder })} />
        </fieldset>
      ) : null}

      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <DiscountField label="最低条件" error={errors.minimum}>
          {(props) => (
            <select {...props} className={INPUT_CLASS} value={state.minimumType} disabled={lock} onChange={(event) => set({ minimumType: event.target.value as FormState['minimumType'] })}>
              <option value="none" disabled={amountValue}>最低条件なし</option>
              <option value="amount">金額</option>
              <option value="quantity" disabled={amountValue}>点数</option>
            </select>
          )}
        </DiscountField>
        {state.minimumType !== 'none' ? (
          <DiscountField label={state.minimumType === 'amount' ? '最低金額（円）' : '最低点数'} hint={amountValue ? '割引額より大きい金額が必要です。' : undefined}>
            {(props) => <input {...props} type="text" inputMode="numeric" className={INPUT_CLASS} value={state.minimumText} disabled={lock} onChange={(event) => set({ minimumText: event.target.value })} />}
          </DiscountField>
        ) : null}
      </div>

      {state.method === 'code' ? (
        <div className="space-y-3">
          <DiscountField label="使える人" error={errors.audience}>
            {(props) => (
              <select {...props} className={INPUT_CLASS} value={state.audience} disabled={lock} onChange={(event) => changeAudience(event.target.value as 'assigned' | 'anyone')}>
                <option value="assigned">割り当てた人だけ</option>
                <option value="anyone">コードを知っていれば誰でも</option>
              </select>
            )}
          </DiscountField>
          <DiscountCheckbox
            label="ログインしていない人も使える"
            checked={state.audience === 'assigned' ? false : state.allowGuests}
            disabled={lock || state.audience === 'assigned'}
            hint={state.audience === 'assigned' ? '割り当てた人は会員なので、ログインしていない人には使えません。' : '外すと会員だけが使えます。'}
            onChange={(allowGuests) => set({ allowGuests })}
          />
        </div>
      ) : null}
      <DiscountCheckbox label="初回の注文だけ" checked={state.firstOrderOnly} disabled={lock} onChange={(firstOrderOnly) => set({ firstOrderOnly })} />

      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <DiscountField label="全体の回数の上限" error={errors.usageLimit} hint="空欄なら上限なしです。">
          {(props) => <input {...props} type="text" inputMode="numeric" className={INPUT_CLASS} value={state.usageLimitText} onChange={(event) => set({ usageLimitText: event.target.value })} />}
        </DiscountField>
        <div className="self-end">
          <DiscountCheckbox label="1人1回まで" checked={state.oncePerCustomer} disabled={lock} onChange={(oncePerCustomer) => set({ oncePerCustomer })} />
        </div>
      </div>

      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <DiscountField label="開始（日本時間）" error={errors.startsAt}>
          {(props) => <input {...props} type="datetime-local" className={INPUT_CLASS} value={state.startsAt} onChange={(event) => set({ startsAt: event.target.value })} />}
        </DiscountField>
        <DiscountField label="終了（日本時間）" error={errors.endsAt} hint="空欄なら期限なしです。">
          {(props) => <input {...props} type="datetime-local" className={INPUT_CLASS} value={state.endsAt} onChange={(event) => set({ endsAt: event.target.value })} />}
        </DiscountField>
      </div>

      <fieldset className="min-w-0 space-y-2" aria-describedby={automatic ? 'discount-stackable-note' : undefined}>
        <legend className="lk-text-3xs font-acumin">ほかの割引と重ねる</legend>
        <DiscountCheckbox label="商品の割引と重ねる" error={errors.combine} checked={state.combinesWithProduct} disabled={lock} onChange={(combinesWithProduct) => set({ combinesWithProduct })} />
        <DiscountCheckbox label="注文の割引と重ねる" checked={state.combinesWithOrder} disabled={lock} onChange={(combinesWithOrder) => set({ combinesWithOrder })} />
        {automatic ? <p id="discount-stackable-note" className="lk-text-3xs text-[#474747] font-acumin">{DISCOUNT_TEXT.stackableNote}</p> : null}
      </fieldset>

      {automatic ? (
        <div className="space-y-3">
          <DiscountCheckbox label="商品の頁で前もって知らせる" checked={state.advertise} onChange={(advertise) => set({ advertise })} hint="会員だけに効く割引は、ログインしていない人には出ません。" />
          {state.advertise ? (
            <DiscountField label="案内文" error={errors.advertisingText}>
              {(props) => <input {...props} type="text" maxLength={200} className={INPUT_CLASS} value={state.advertisingText} onChange={(event) => set({ advertisingText: event.target.value })} />}
            </DiscountField>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="font-acumin" disabled={submitting}>{creating ? '作成する' : '保存する'}</Button>
      </div>
    </form>
  );
}
