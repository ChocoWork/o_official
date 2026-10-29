'use client';

// File: src/features/discounts/components/DiscountDetail.tsx
// 割引の詳細（グループ H / FREQ-547-AC-01〜03・FREQ-543-AC-03）。設定の要約、止める／再開する／複製／編集、割り当てを足す、割り当ての表。
// 操作は応答の permissions.manage があるときだけ出す（窓口と DB が守る。無い人には出さない）。
// 変更の成功後は詳細を読み直す。読み直せなかった間は「変更しましたが、最新の情報を読み込めませんでした。」を出し、古い表への操作を止める。
// 一覧は、この頁から戻って開き直すときに読み直される。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button/Button';
import { clientFetch } from '@/lib/client-fetch';
import type { AdminDiscountDetail, DiscountMember } from '@/lib/discounts/admin-discount-types';
import type { DiscountDefinition } from '@/lib/discounts/discount-types';
import {
  DISCOUNT_TEXT, KIND_LABELS, METHOD_LABELS, STATUS_LABELS, assignmentMode, createRequestKeys, discountStatus, drainBody,
  fetchDiscountDetail, formatJst, readDiscountFailure, yen,
} from '../discount-admin-client';
import DiscountAssignments from './DiscountAssignments';
import { DiscountField, INPUT_CLASS } from './DiscountField';
import DiscountMemberPicker from './DiscountMemberPicker';

const PREFIX_PATTERN = /^[A-Z0-9]([A-Z0-9-]{0,53}[A-Z0-9])?$/;
const ACTION_FAILED = '操作に失敗しました。';
const BACK_HREF = '/admin?tab=DISCOUNT';

function summaryRows(d: DiscountDefinition): Array<[string, string]> {
  const value = d.value.type === 'percent' ? `${d.value.value}％引き` : `${yen(d.value.value)}引き`;
  const target = d.targetMode === 'all' ? '全部' : d.targetMode === 'exclude' ? `${d.itemIds.length}点を除く` : `${d.itemIds.length}点`;
  const minimum = d.minimum.type === 'none' ? 'なし' : d.minimum.type === 'amount' ? `${yen(d.minimum.value)}以上` : `${d.minimum.value}点以上`;
  const combines = [d.combinesWithProduct ? '商品の割引と重ねる' : null, d.combinesWithOrder ? '注文の割引と重ねる' : null].filter(Boolean).join('・');
  const rows: Array<[string, string]> = [
    ['種類', KIND_LABELS[d.kind]],
    ['効き方', METHOD_LABELS[d.method]],
    ['状態', STATUS_LABELS[discountStatus(d)]],
    ['割引', value],
    ['対象の服', target],
    ['最低条件', minimum],
  ];
  if (d.method === 'code') {
    rows.push(['使える人', d.audience === 'assigned' ? '割り当てた人だけ' : 'コードを知っていれば誰でも']);
    rows.push(['ログインしていない人', d.allowGuests ? '使える' : '使えない（会員だけ）']);
  }
  rows.push(
    ['初回の注文だけ', d.firstOrderOnly ? 'はい' : 'いいえ'],
    ['全体の回数', d.usageLimit === null ? '上限なし' : `${d.usageLimit}回まで`],
    ['1人1回まで', d.oncePerCustomer ? 'はい' : 'いいえ'],
    ['期間（日本時間）', `${formatJst(d.startsAt)} 〜 ${d.endsAt === null ? '無期限' : formatJst(d.endsAt)}`],
    ['重ね方', combines || '重ねない'],
  );
  if (d.kind === 'repeat') {
    rows.push(['リピートの数え方', [d.repeatPrevious ? '前の注文の分を数える（A）' : null, d.repeatInOrder ? '同じ注文の2着目から（B）' : null].filter(Boolean).join('・')]);
  }
  if (d.method === 'automatic') rows.push(['前もって知らせる', d.advertise ? `知らせる（${d.advertisingText ?? ''}）` : '知らせない']);
  return rows;
}

/** 全画面（390px）／中央（md 以上）の窓。右上の ×・Esc で閉じ、開く時に見出しへ、閉じる時に開いた物へフォーカスを戻す */
function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }): React.JSX.Element {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    headingRef.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
      else document.getElementById('discount-detail-title')?.focus();
    };
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-stretch bg-black/40 md:items-center md:justify-center">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="discount-dialog-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); onClose(); }
          if (event.key !== 'Tab') return;
          const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') ?? []);
          const first = controls[0]; const last = controls.at(-1);
          if (event.shiftKey && (document.activeElement === first || document.activeElement === headingRef.current)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
        className="relative w-full min-w-0 overflow-y-auto bg-white p-4 pt-14 md:max-h-[90vh] md:max-w-xl md:p-6 md:pt-14"
      >
        <button type="button" aria-label="閉じる" onClick={onClose} className="absolute right-3 top-3 flex h-10 w-10 items-center justify-center text-2xl leading-none">×</button>
        <h2 id="discount-dialog-title" ref={headingRef} tabIndex={-1} className="mb-4 lk-text-lg">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function AddAssignmentsDialog({ detail, onClose, onAdded }: {
  detail: AdminDiscountDetail;
  onClose: () => void;
  onAdded: (message: string) => Promise<void>;
}): React.JSX.Element {
  const mode = assignmentMode(detail.codes);
  const [members, setMembers] = useState<DiscountMember[]>([]);
  const [prefix, setPrefix] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const keys = useRef(createRequestKeys());
  const normalizedPrefix = prefix.trim().toUpperCase();
  const prefixOk = PREFIX_PATTERN.test(normalizedPrefix);
  const needsPrefix = mode.mode === 'batch';

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (submittingRef.current) return;
    if (members.length === 0) { setError('会員を選んでください。'); return; }
    if (needsPrefix && !prefixOk) { setError('コードの先頭の文字は、英数字とハイフンの1〜55字で入力してください。'); return; }
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    const userIds = members.map((member) => member.userId).sort();
    const signature = `${mode.mode}:${normalizedPrefix}:${userIds.join(',')}`;
    try {
      const response = await clientFetch(`/api/admin/discounts/${detail.discount.id}/${mode.mode === 'shared' ? 'assign' : 'codes'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode.mode === 'shared'
          ? { codeId: mode.codeId, userIds, requestKey: keys.current.keyFor(signature) }
          : { prefix: normalizedPrefix, userIds, count: userIds.length, requestKey: keys.current.keyFor(signature) }),
      });
      if (!response.ok) {
        setError((await readDiscountFailure(response, ACTION_FAILED, DISCOUNT_TEXT.manageForbidden)).message);
        return;
      }
      await drainBody(response);
      keys.current.done(signature);
      await onAdded(`${members.length}人に割り当てました。`);
    } catch (caught) {
      console.error('Failed to add discount assignments:', caught instanceof Error ? caught.name : 'UnknownError');
      setError(ACTION_FAILED);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Dialog title="割り当てを足す" onClose={onClose}>
      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        {needsPrefix ? (
          <DiscountField
            label="コードの先頭の文字"
            hint={prefixOk ? `コードは「${normalizedPrefix}-」に4〜8文字が続く形で、選んだ人数分を1人に1つずつ作ります。先頭の文字だけでは使えません。` : '英数字とハイフンで入力します。選んだ人数分の使い捨てのコードを作ります。'}
          >
            {(props) => <input {...props} type="text" maxLength={55} autoComplete="off" className={INPUT_CLASS} value={prefix} onChange={(event) => setPrefix(event.target.value)} />}
          </DiscountField>
        ) : null}
        <DiscountMemberPicker selected={members} onChange={setMembers} />
        {error ? <p role="alert" className="lk-text-sm text-red-700 font-acumin">{error}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" className="font-acumin" disabled={submitting}>割り当てる</Button>
          <Button variant="secondary" size="sm" className="font-acumin" onClick={onClose}>やめる</Button>
        </div>
      </form>
    </Dialog>
  );
}

type Phase = 'loading' | 'ready' | 'forbidden' | 'notFound' | 'error';

export default function DiscountDetail({ discountId }: { discountId: string }): React.JSX.Element {
  const router = useRouter();
  const [detail, setDetail] = useState<AdminDiscountDetail | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [errorMessage, setErrorMessage] = useState<string>(DISCOUNT_TEXT.listFailed);
  const [page, setPage] = useState(1);
  const [loadingPage, setLoadingPage] = useState(false);
  const [pageError, setPageError] = useState(false);
  const pendingPage = useRef(1);
  const [staleMessage, setStaleMessage] = useState<string>(DISCOUNT_TEXT.staleAfterChange);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const requestSeq = useRef(0);
  const hasDetail = useRef(false);
  const busyRef = useRef(false);
  const keys = useRef(createRequestKeys());

  const load = useCallback(async (nextPage: number): Promise<boolean> => {
    const request = ++requestSeq.current;
    pendingPage.current = nextPage;
    setLoadingPage(true);
    setPageError(false);
    const result = await fetchDiscountDetail(discountId, nextPage);
    if (request !== requestSeq.current) return false;
    setLoadingPage(false);
    if (result.kind === 'ready') {
      hasDetail.current = true;
      setDetail(result.data);
      setPage(nextPage);
      setPhase('ready');
      setStale(false);
      return true;
    }
    if (hasDetail.current) setPageError(true);
    if (!hasDetail.current) {
      setPhase(result.kind);
      if (result.kind === 'error') setErrorMessage(result.message);
    }
    return false;
  }, [discountId]);

  useEffect(() => {
    void load(1);
    return () => { requestSeq.current += 1; };
  }, [load]);

  /** 変更の後の読み直し。読めなければ古い表への操作を止める */
  const reloadAfterChange = useCallback(async (changed = true): Promise<boolean> => {
    const ok = await load(page);
    if (!ok) { setStaleMessage(changed ? DISCOUNT_TEXT.staleAfterChange : '最新の情報を読み込めませんでした。'); setStale(true); }
    return ok;
  }, [load, page]);

  const run = async (signature: string, send: (requestKey: string) => Promise<Response>, onSuccess: (response: Response) => Promise<void>): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const response = await send(keys.current.keyFor(signature));
      if (!response.ok) {
        const failure = await readDiscountFailure(response, ACTION_FAILED, DISCOUNT_TEXT.manageForbidden);
        setActionError(failure.message);
        if (failure.status === 409) await reloadAfterChange(false);
        return;
      }
      keys.current.done(signature);
      await onSuccess(response);
    } catch (caught) {
      console.error('Failed to change admin discount:', caught instanceof Error ? caught.name : 'UnknownError');
      setActionError(ACTION_FAILED);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const post = (path: string, body: Record<string, unknown>, method = 'POST') => clientFetch(`/api/admin/discounts/${discountId}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  const handleToggleStopped = (): Promise<void> => {
    if (!detail) return Promise.resolve();
    const { version, stopped } = detail.discount;
    const action = stopped ? 'resume' : 'stop';
    return run(`${action}:${version}`, (requestKey) => post(`/${action}`, { expectedVersion: version, requestKey }), async (response) => {
      await drainBody(response);
      if (await reloadAfterChange()) setNotice(stopped ? '再開しました。' : '止めました。');
    });
  };
  const handleDuplicate = (): Promise<void> => {
    if (!detail) return Promise.resolve();
    return run(`duplicate:${detail.discount.version}`, (requestKey) => post('/duplicate', { requestKey }), async (response) => {
      const json = (await response.json()) as { data?: { discountId?: unknown } };
      if (typeof json.data?.discountId !== 'string') { setActionError(ACTION_FAILED); return; }
      router.push(`/admin/discounts/${json.data.discountId}`);
    });
  };
  const handleAcknowledge = (): Promise<void> => {
    if (!detail) return Promise.resolve();
    const { version } = detail.discount;
    return run(`acknowledge:${version}`, (requestKey) => post('', { patch: { acknowledgeSearchAttention: true }, expectedVersion: version, requestKey }, 'PATCH'), async (response) => {
      await drainBody(response);
      if (await reloadAfterChange()) setNotice('確認済みにしました。');
    });
  };
  const handleAdded = async (message: string): Promise<void> => {
    setAddOpen(false);
    if (await reloadAfterChange()) setNotice(message);
    titleRef.current?.focus();
  };

  const back = <Button href={BACK_HREF} variant="secondary">一覧に戻る</Button>;
  if (!detail) {
    return (
      <div className="min-w-0 space-y-4">
        {back}
        {phase === 'loading' ? <p role="status" className="lk-text-sm font-acumin">{DISCOUNT_TEXT.loading}</p> : null}
        {phase === 'forbidden' ? <p role="alert" className="lk-text-sm text-red-700 font-acumin">{DISCOUNT_TEXT.listForbidden}</p> : null}
        {phase === 'notFound' ? <p role="alert" className="lk-text-sm text-red-700 font-acumin">{DISCOUNT_TEXT.detailNotFound}</p> : null}
        {phase === 'error' ? (
          <>
            <p role="alert" className="lk-text-sm text-red-700 font-acumin">{errorMessage}</p>
            <Button variant="secondary" size="sm" className="font-acumin" onClick={() => { setPhase('loading'); void load(page); }}>{DISCOUNT_TEXT.reload}</Button>
          </>
        ) : null}
      </div>
    );
  }

  const { discount, permissions } = detail;
  const canOperate = permissions.manage && !stale && !loadingPage;
  const sharesCodes = discount.method === 'code' && discount.audience === 'assigned';

  return (
    <div className="w-full min-w-0 max-w-full space-y-6">
      {back}
      <div className="space-y-1">
        <h1 id="discount-detail-title" ref={titleRef} tabIndex={-1} className="lk-text-xl break-words">{discount.name}</h1>
        <p className="lk-text-sm text-[#474747] font-acumin">{STATUS_LABELS[discountStatus(discount)]}・{KIND_LABELS[discount.kind]}・{METHOD_LABELS[discount.method]}</p>
      </div>

      {notice ? <p role="status" className="lk-text-sm font-acumin">{notice}</p> : null}
      {actionError ? <p role="alert" className="lk-text-sm text-red-700 font-acumin">{actionError}</p> : null}
      {stale ? (
        <div className="space-y-2">
          <p role="alert" className="lk-text-sm text-red-700 font-acumin">{staleMessage}</p>
          <Button variant="secondary" size="sm" className="font-acumin" onClick={() => void reloadAfterChange(staleMessage === DISCOUNT_TEXT.staleAfterChange)}>{DISCOUNT_TEXT.reload}</Button>
        </div>
      ) : null}

      {detail.searchAttention ? (
        <div className="space-y-2 border border-red-700/40 p-3">
          <p role="alert" className="lk-text-sm text-red-700 font-acumin">{DISCOUNT_TEXT.attention}（{detail.searchAttention.count}件）</p>
          {canOperate ? <Button variant="secondary" size="sm" className="font-acumin" disabled={busy} onClick={() => void handleAcknowledge()}>確認済みにする</Button> : null}
        </div>
      ) : null}

      {canOperate ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" className="font-acumin" disabled={busy} onClick={() => void handleToggleStopped()}>{discount.stopped ? '再開する' : '止める'}</Button>
          <Button variant="secondary" size="sm" className="font-acumin" disabled={busy} onClick={() => void handleDuplicate()}>複製</Button>
          <Button href={`/admin/discounts/${discount.id}/edit`} variant="secondary" size="sm" className="font-acumin">編集</Button>
          {sharesCodes ? (
            <Button variant="secondary" size="sm" className="font-acumin" disabled={busy} onClick={() => setAddOpen(true)}>割り当てを足す</Button>
          ) : null}
        </div>
      ) : null}

      <dl className="grid min-w-0 gap-x-6 gap-y-2 border-y border-black/10 py-4 sm:grid-cols-[14rem_1fr]">
        {summaryRows(discount).map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="lk-text-3xs text-[#474747] font-acumin">{label}</dt>
            <dd className="min-w-0 break-words lk-text-sm font-acumin">{value}</dd>
          </div>
        ))}
      </dl>

      {detail.used && permissions.manage ? <p className="lk-text-3xs text-[#474747] font-acumin">{DISCOUNT_TEXT.usedNote}</p> : null}

      {discount.method === 'code' ? (
        <DiscountAssignments detail={detail} page={page} onPage={(next) => { void load(next); }}
          onChanged={async (changed = true) => { await reloadAfterChange(changed); }} disabled={stale || loadingPage}
          loading={loadingPage} loadError={pageError && !stale} onRetry={() => { void load(pendingPage.current); }} />
      ) : (
        <p className="lk-text-sm text-[#474747] font-acumin">自動の割引にはコードの割り当てはありません。</p>
      )}

      {addOpen ? <AddAssignmentsDialog detail={detail} onClose={() => setAddOpen(false)} onAdded={handleAdded} /> : null}
    </div>
  );
}
