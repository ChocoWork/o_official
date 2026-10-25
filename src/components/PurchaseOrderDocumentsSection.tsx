'use client';

// File: src/components/PurchaseOrderDocumentsSection.tsx
// 発注書の詳細の「取引書類」（G-2 Task 8 / FREQ-530）。見積書・請求書の原本の一覧と、書類を追加する・差し替える・情報を訂正する・無効にする操作、
// 原本を表示・ダウンロード・印刷するリンク、保存が終わっていないファイル（予約だけで添付に結ばれていない物）の「続きから保存」を出す。
// 確定前のファイルは添付済みと見せない（添付の一覧には出さず、保存が終わっていないファイルにだけ出す）。期限を過ぎた予約も確認済みにして消せず、残り続ける。
// 原本の表示・ダウンロード・印刷は、60秒だけ使える署名つきリンクを窓口からもらって開く（リンクは文にも記録にも出さない）。印刷は開いたタブのブラウザの印刷で行う。
import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { usePurchaseOrderWrite } from '@/hooks/usePurchaseOrderWrite';
import {
  fetchPurchaseOrderDocumentUrl,
  openBlankDocumentTab,
  PURCHASE_ORDER_DOCUMENT_ACCEPT,
  resumePurchaseOrderDocument,
  uploadPurchaseOrderDocument,
} from '@/lib/purchase-orders/purchase-order-documents-client';
import {
  formatPurchaseOrderDate,
  formatPurchaseOrderDay,
  formatYen,
  isPurchaseOrderDay,
  PURCHASE_ORDER_ATTACHMENT_KIND_LABELS,
  PURCHASE_ORDER_DOCUMENT_MIN_DAY,
  PURCHASE_ORDER_DOCUMENT_TEXT,
  PURCHASE_ORDER_ERRORS,
  PURCHASE_ORDER_LIMITS,
  PURCHASE_ORDER_TEXT,
  type PurchaseOrderAttachment,
  type PurchaseOrderAttachmentKind,
  type PurchaseOrderDetail,
  type PurchaseOrderDocumentMeta,
  type PurchaseOrderPendingUpload,
} from '@/lib/purchase-orders/purchase-order-types';

const TEXT = PURCHASE_ORDER_DOCUMENT_TEXT;
const FIELD_CLASS =
  'w-full border border-black/20 bg-white px-3 py-2 lk-text-2xs text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/40';
const BADGE_CLASS = 'inline-block border border-black/30 px-2 py-0.5 lk-text-2xs';
const KINDS = Object.keys(PURCHASE_ORDER_ATTACHMENT_KIND_LABELS) as PurchaseOrderAttachmentKind[];

type Props = {
  purchaseOrder: PurchaseOrderDetail;
  /** 保存・訂正・無効化ができた。親が発注書を読み直し、通知の文を出す */
  onSaved: (notice: string) => void;
  /** 通知なしで発注書を読み直す（保存の途中で止まった予約を一覧に出すため） */
  onReload: () => void;
};

type DialogState =
  | { type: 'add' }
  | { type: 'replace'; attachment: PurchaseOrderAttachment }
  | { type: 'resume'; pending: PurchaseOrderPendingUpload }
  | { type: 'correct'; attachment: PurchaseOrderAttachment }
  | { type: 'void'; attachment: PurchaseOrderAttachment };

type FormValues = { transactionDate: string; amount: string; counterparty: string };
const EMPTY_FORM: FormValues = { transactionDate: '', amount: '', counterparty: '' };

function valuesOf(attachment: PurchaseOrderAttachment): FormValues {
  const { transactionDate, amountYen, counterparty } = attachment.current;
  return { transactionDate, amount: String(amountYen), counterparty };
}

/** 入力欄の文字を、窓口に送る値にする。取引日・金額・取引先のどれかが合わなければ null */
function readValues(values: FormValues): { transactionDate: string; amountYen: number; counterparty: string } | null {
  const counterparty = values.counterparty.trim();
  const amountText = values.amount.trim();
  if (!isPurchaseOrderDay(values.transactionDate) || values.transactionDate < PURCHASE_ORDER_DOCUMENT_MIN_DAY) return null;
  if (!/^[0-9]{1,11}$/.test(amountText)) return null;
  const amountYen = Number(amountText);
  if (amountYen > PURCHASE_ORDER_LIMITS.documentAmountYen.max) return null;
  if (counterparty.length < PURCHASE_ORDER_LIMITS.counterparty.min || counterparty.length > PURCHASE_ORDER_LIMITS.counterparty.max) return null;
  return { transactionDate: values.transactionDate, amountYen, counterparty };
}

/** 取引日・金額・取引先の入力欄（追加・差し替え・続きから保存・訂正で共通） */
function MetaFields({ ids, values, disabled, onChange }: {
  ids: string;
  values: FormValues;
  disabled: boolean;
  onChange: (next: FormValues) => void;
}): React.JSX.Element {
  return (
    <>
      <div className="space-y-1">
        <label htmlFor={`${ids}-date`} className="block lk-text-2xs">{TEXT.transactionDateLabel}</label>
        <input
          id={`${ids}-date`}
          type="date"
          required
          min={PURCHASE_ORDER_DOCUMENT_MIN_DAY}
          value={values.transactionDate}
          disabled={disabled}
          onChange={(event) => onChange({ ...values, transactionDate: event.target.value })}
          className={FIELD_CLASS}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${ids}-amount`} className="block lk-text-2xs">{TEXT.amountLabel}</label>
        <input
          id={`${ids}-amount`}
          type="text"
          inputMode="numeric"
          required
          value={values.amount}
          disabled={disabled}
          onChange={(event) => onChange({ ...values, amount: event.target.value })}
          className={FIELD_CLASS}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${ids}-counterparty`} className="block lk-text-2xs">{TEXT.counterpartyLabel}</label>
        <input
          id={`${ids}-counterparty`}
          type="text"
          required
          maxLength={PURCHASE_ORDER_LIMITS.counterparty.max}
          value={values.counterparty}
          disabled={disabled}
          onChange={(event) => onChange({ ...values, counterparty: event.target.value })}
          className={FIELD_CLASS}
        />
      </div>
    </>
  );
}

type UploadDialogProps = {
  purchaseOrderId: string;
  /** add: 新しい書類 / replace: 差し替え（元の書類の種類と情報を初期値にする）/ resume: 保存が終わっていないファイルの続き */
  mode: 'add' | 'replace' | 'resume';
  attachment?: PurchaseOrderAttachment;
  pending?: PurchaseOrderPendingUpload;
  /** この画面で送れなかったファイルと入力（読み直す前の再開では手元にある）。差し替えの関係は予約に残っているので持たない */
  remembered?: { file: File; meta: PurchaseOrderDocumentMeta };
  onClose: () => void;
  onSaved: (notice: string) => void;
  /** 送れなかった。予約は残る（add / replace）。ファイルと入力を覚えておき、一覧に出す */
  onPending: (reservationId: string, file: File, meta: PurchaseOrderDocumentMeta, message: string) => void;
  /** 発注書を読み直す（予約が増えた・減った時に、保存が終わっていないファイルの一覧を合わせる） */
  onReload: () => void;
};

/**
 * 書類を追加する・差し替える・続きから保存する。ファイルは置き場へ直接送り、続けて確定する（順は purchase-order-documents-client）。
 * 続きから保存は、置き場に無ければファイルの選び直しを求め（needs_file）、置き場のファイルが種類の検査に通らなかった時（rejected）は
 * 続きから保存を繰り返しても通らないので、同じ画面でファイルを選び直させて新しい予約で保存し直す（種類と差し替えの関係は
 * 止まった予約から引き継ぐ。止まった予約は置き場に残り、期限が過ぎても一覧に残る）。
 */
function DocumentUploadDialog({ purchaseOrderId, mode, attachment, pending, remembered, onClose, onSaved, onPending, onReload }: UploadDialogProps): React.JSX.Element {
  const ids = useId();
  const [kind, setKind] = useState<PurchaseOrderAttachmentKind>(attachment?.kind ?? 'invoice');
  const [values, setValues] = useState<FormValues>(
    remembered
      ? { transactionDate: remembered.meta.transactionDate, amount: String(remembered.meta.amountYen), counterparty: remembered.meta.counterparty }
      : attachment ? valuesOf(attachment) : EMPTY_FORM,
  );
  const [file, setFile] = useState<File | null>(remembered?.file ?? null);
  // ファイルの欄を作り直す番号（選んだファイルを捨てた時に、欄に残る名前も消す）
  const [fileKey, setFileKey] = useState(0);
  // 置き場にファイルが無く、選び直しを求められた（続きから保存だけ）
  const [needsFile, setNeedsFile] = useState(false);
  // 置き場のファイルが種類の検査に通らず、新しい予約で保存し直す（続きから保存だけ）
  const [restart, setRestart] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sendingRef = useRef(false);

  const title = mode === 'add' ? TEXT.addTitle : mode === 'replace' ? TEXT.replaceTitle : TEXT.resumeTitle;
  const showFile = mode !== 'resume' || needsFile || restart;
  const showKind = mode !== 'resume';
  const handleClose = (): void => {
    if (!sendingRef.current) onClose();
  };
  const discardFile = (): void => {
    setFile(null);
    setFileKey((key) => key + 1);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (sendingRef.current) return;
    const meta = readValues(values);
    if (meta === null) {
      setError(TEXT.inputRequired);
      return;
    }
    if (showFile && file === null) {
      setError(TEXT.fileRequired);
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      if (mode === 'resume' && pending && !restart) {
        const result = await resumePurchaseOrderDocument({
          purchaseOrderId, reservationId: pending.reservationId, reservationFileName: pending.fileName, file, meta,
        });
        if (result.kind === 'ok') {
          onSaved(TEXT.savedNotice);
          return;
        }
        if (result.kind === 'needs_file') {
          setNeedsFile(true);
          setError(TEXT.selectFileAgain);
          return;
        }
        if (result.kind === 'rejected') {
          setRestart(true);
          discardFile();
        }
        // 断り・止まったまま・種類の検査に通らない: 文を出す。すでに登録済みなどで一覧が変わりうるので読み直す
        setError(result.message);
        onReload();
        return;
      }
      if (file === null) return;
      const result = await uploadPurchaseOrderDocument({
        purchaseOrderId,
        file,
        kind: mode === 'resume' && pending ? pending.kind : kind,
        meta: {
          ...meta,
          replacesAttachmentId: mode === 'resume' && pending ? pending.replacesAttachmentId : mode === 'replace' && attachment ? attachment.id : null,
        },
      });
      if (result.kind === 'ok') onSaved(TEXT.savedNotice);
      else if (result.kind === 'pending') onPending(result.reservationId, file, meta, result.message);
      else {
        if (result.kind === 'rejected') {
          discardFile();
          onReload();
        }
        setError(result.message);
      }
    } catch {
      setError(PURCHASE_ORDER_TEXT.failed);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  return (
    <Dialog open onClose={handleClose} title={title} fullScreenOnMobile>
      <form className="space-y-3" noValidate onSubmit={(event) => void handleSubmit(event)}>
        {pending ? <p className="break-words">{`${PURCHASE_ORDER_ATTACHMENT_KIND_LABELS[pending.kind]} ${pending.fileName}`}</p> : null}
        {showKind ? (
          <div className="space-y-1">
            <label htmlFor={`${ids}-kind`} className="block lk-text-2xs">{TEXT.kindLabel}</label>
            <select
              id={`${ids}-kind`}
              value={kind}
              disabled={sending}
              onChange={(event) => setKind(event.target.value as PurchaseOrderAttachmentKind)}
              className={FIELD_CLASS}
            >
              {KINDS.map((value) => <option key={value} value={value}>{PURCHASE_ORDER_ATTACHMENT_KIND_LABELS[value]}</option>)}
            </select>
          </div>
        ) : null}
        <MetaFields ids={ids} values={values} disabled={sending} onChange={setValues} />
        {showFile ? (
          <div className="space-y-1">
            <label htmlFor={`${ids}-file`} className="block lk-text-2xs">{TEXT.fileLabel}</label>
            <input
              key={fileKey}
              id={`${ids}-file`}
              type="file"
              accept={PURCHASE_ORDER_DOCUMENT_ACCEPT}
              disabled={sending}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className={FIELD_CLASS}
            />
          </div>
        ) : null}
        {error !== null ? <p role="alert" className="lk-text-2xs text-red-600">{error}</p> : null}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={sending}>{TEXT.save}</Button>
          <Button type="button" variant="secondary" disabled={sending} onClick={handleClose}>{TEXT.back}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** 窓口の成功の応答（訂正・無効化）か。次の版の番号が整数で付いている */
function isRevised(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false;
  const { attachmentId, revisionNo } = body as { attachmentId?: unknown; revisionNo?: unknown };
  return typeof attachmentId === 'string' && typeof revisionNo === 'number' && Number.isInteger(revisionNo) && revisionNo >= 2;
}

/**
 * 書類の情報の訂正（取引日・金額・取引先を直す）と無効化。どちらも次の版を足し、理由が必須。
 * 訂正は今の「無効」かどうかを変えず、無効化は情報をそのままに無効にする。同じ内容の再押下は同じ requestKey で送る（usePurchaseOrderWrite）。
 */
function DocumentReviseDialog({ purchaseOrderId, attachment, mode, onClose, onSaved }: {
  purchaseOrderId: string;
  attachment: PurchaseOrderAttachment;
  mode: 'correct' | 'void';
  onClose: () => void;
  onSaved: (notice: string) => void;
}): React.JSX.Element {
  const ids = useId();
  const [values, setValues] = useState<FormValues>(valuesOf(attachment));
  const [reason, setReason] = useState('');
  const write = usePurchaseOrderWrite({
    url: `/api/admin/purchase-orders/${encodeURIComponent(purchaseOrderId)}/attachments/${encodeURIComponent(attachment.id)}/revisions`,
    method: 'POST',
    onSaved,
    onStale: () => undefined,
    isSaved: isRevised,
  });
  const handleClose = write.guardClose(onClose);
  const [formError, setFormError] = useState<string | null>(null);
  const voiding = mode === 'void';

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const read = readValues(voiding ? valuesOf(attachment) : values);
    const why = reason.trim();
    if (read === null) {
      setFormError(TEXT.inputRequired);
      return;
    }
    if (why === '') {
      setFormError(PURCHASE_ORDER_ERRORS.GROUP_G_PO_REASON_REQUIRED[2]);
      return;
    }
    setFormError(null);
    const voided = voiding ? true : attachment.current.voided;
    void write.submit(
      JSON.stringify({ ...read, voided, why }),
      (requestKey) => ({ ...read, currency: 'JPY', voided, reason: why, requestKey }),
      voiding ? TEXT.voidedNotice : TEXT.correctedNotice,
    );
  };

  const message = formError ?? write.error;
  return (
    <Dialog open onClose={handleClose} title={voiding ? TEXT.voidTitle : TEXT.correctTitle} fullScreenOnMobile>
      <form className="space-y-3" noValidate onSubmit={handleSubmit}>
        <p className="break-words">{`${PURCHASE_ORDER_ATTACHMENT_KIND_LABELS[attachment.kind]} ${attachment.fileName}`}</p>
        {voiding ? null : <MetaFields ids={ids} values={values} disabled={write.sending} onChange={setValues} />}
        <div className="space-y-1">
          <label htmlFor={`${ids}-reason`} className="block lk-text-2xs">{TEXT.reasonLabel}</label>
          <textarea
            id={`${ids}-reason`}
            rows={3}
            required
            maxLength={PURCHASE_ORDER_LIMITS.reason.max}
            value={reason}
            disabled={write.sending}
            onChange={(event) => setReason(event.target.value)}
            className={FIELD_CLASS}
          />
        </div>
        {message !== null ? <p role="alert" className="lk-text-2xs text-red-600">{message}</p> : null}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={write.sending}>{voiding ? TEXT.void : TEXT.correctSubmit}</Button>
          <Button type="button" variant="secondary" disabled={write.sending} onClick={handleClose}>{TEXT.back}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export default function PurchaseOrderDocumentsSection({ purchaseOrder, onSaved, onReload }: Props): React.JSX.Element {
  const headingId = useId();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  // この画面で送れなかったファイルと入力。ページを読み直すと無くなる（その時は続きから保存でファイルを選び直す）
  const [remembered, setRemembered] = useState<ReadonlyMap<string, { file: File; meta: PurchaseOrderDocumentMeta }>>(new Map());

  /**
   * 署名つきリンクをもらって、表示・印刷は新しいタブ、ダウンロードは保存で開く（リンクは文にも記録にも出さない）。
   * 表示・印刷のタブは、リンクを待つ前にクリックの中で空で開き、リンクが取れてからそのタブを移す
   * （待った後の window.open は Safari が止めることがあるため）。止められたら文を出し、リンクは取らない。取れなければタブを閉じる。
   */
  const openDocument = async (attachment: PurchaseOrderAttachment, download: boolean): Promise<void> => {
    if (opening) return;
    const tab = download ? null : openBlankDocumentTab();
    if (!download && tab === null) {
      setMessage(TEXT.openBlocked);
      return;
    }
    setOpening(true);
    setMessage(null);
    try {
      const result = await fetchPurchaseOrderDocumentUrl(purchaseOrder.id, attachment.id, download);
      if (!result.ok) {
        tab?.close();
        setMessage(result.message);
        return;
      }
      if (tab) {
        tab.location.href = result.url;
      } else {
        const link = document.createElement('a');
        link.href = result.url;
        link.rel = 'noopener';
        link.click();
      }
    } catch {
      tab?.close();
      setMessage(TEXT.openFailed);
    } finally {
      setOpening(false);
    }
  };

  const closeDialog = (): void => setDialog(null);
  const handleSaved = (notice: string): void => {
    setDialog(null);
    setMessage(null);
    onSaved(notice);
  };
  const handlePending = (reservationId: string, file: File, meta: PurchaseOrderDocumentMeta, failure: string): void => {
    setRemembered((current) => new Map(current).set(reservationId, { file, meta }));
    setDialog(null);
    setMessage(`${TEXT.pendingNotice} ${failure}`);
    onReload();
  };

  const attachments = purchaseOrder.attachments;
  const pendingUploads = purchaseOrder.pendingUploads;
  const resumeTarget = dialog?.type === 'resume' ? dialog.pending : undefined;

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="lk-text-lg">{TEXT.heading}</h2>
      <div className="flex flex-wrap gap-3">
        <Button size="sm" onClick={() => setDialog({ type: 'add' })}>{TEXT.add}</Button>
      </div>
      {message !== null ? <p role="alert" className="break-words lk-text-2xs">{message}</p> : null}

      {attachments.length === 0 ? <p>{TEXT.empty}</p> : (
        <ul className="space-y-4">
          {attachments.map((attachment) => (
            <li key={attachment.id} data-testid="purchase-order-document" className="space-y-2 border border-black/15 p-3">
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>{PURCHASE_ORDER_ATTACHMENT_KIND_LABELS[attachment.kind]}</span>
                <span className="break-all">{attachment.fileName}</span>
                {attachment.current.voided ? <span className={BADGE_CLASS}>{TEXT.voidedBadge}</span> : null}
              </p>
              <p className="break-words">
                {`${TEXT.transactionDateLabel} ${formatPurchaseOrderDay(attachment.current.transactionDate)}　${TEXT.amountLabel} ${formatYen(attachment.current.amountYen)}　${TEXT.counterpartyLabel} ${attachment.current.counterparty}`}
              </p>
              {attachment.current.reason !== null ? <p className="break-words">{`${TEXT.reasonLabel} ${attachment.current.reason}`}</p> : null}
              <div role="group" aria-label={`${attachment.fileName} の操作`} className="flex flex-wrap gap-3">
                <Button size="sm" variant="secondary" disabled={opening} onClick={() => void openDocument(attachment, false)}>{TEXT.view}</Button>
                <Button size="sm" variant="secondary" disabled={opening} onClick={() => void openDocument(attachment, true)}>{TEXT.download}</Button>
                <Button size="sm" variant="secondary" disabled={opening} onClick={() => void openDocument(attachment, false)}>{TEXT.print}</Button>
                <Button size="sm" variant="secondary" onClick={() => setDialog({ type: 'correct', attachment })}>{TEXT.correct}</Button>
                <Button size="sm" variant="secondary" onClick={() => setDialog({ type: 'replace', attachment })}>{TEXT.replace}</Button>
                {attachment.current.voided ? null : (
                  <Button size="sm" variant="secondary" onClick={() => setDialog({ type: 'void', attachment })}>{TEXT.void}</Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {pendingUploads.length > 0 ? (
        <div className="space-y-3">
          <h3 className="lk-text-md">{TEXT.pendingHeading}</h3>
          <ul className="space-y-3">
            {pendingUploads.map((pending) => (
              <li key={pending.reservationId} data-testid="purchase-order-pending-upload" className="space-y-2 border border-black/15 p-3">
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span>{PURCHASE_ORDER_ATTACHMENT_KIND_LABELS[pending.kind]}</span>
                  <span className="break-all">{pending.fileName}</span>
                  <span className="tabular-nums">{formatPurchaseOrderDate(pending.createdAt)}</span>
                </p>
                {pending.expired ? <p className="break-words">{TEXT.expired}</p> : null}
                <div className="flex flex-wrap gap-3">
                  <Button size="sm" variant="secondary" onClick={() => setDialog({ type: 'resume', pending })}>{TEXT.resume}</Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {dialog?.type === 'add' ? (
        <DocumentUploadDialog purchaseOrderId={purchaseOrder.id} mode="add" onClose={closeDialog} onSaved={handleSaved} onPending={handlePending} onReload={onReload} />
      ) : null}
      {dialog?.type === 'replace' ? (
        <DocumentUploadDialog
          purchaseOrderId={purchaseOrder.id}
          mode="replace"
          attachment={dialog.attachment}
          onClose={closeDialog}
          onSaved={handleSaved}
          onPending={handlePending}
          onReload={onReload}
        />
      ) : null}
      {resumeTarget ? (
        <DocumentUploadDialog
          purchaseOrderId={purchaseOrder.id}
          mode="resume"
          pending={resumeTarget}
          remembered={remembered.get(resumeTarget.reservationId)}
          onClose={closeDialog}
          onSaved={handleSaved}
          onPending={handlePending}
          onReload={onReload}
        />
      ) : null}
      {dialog?.type === 'correct' || dialog?.type === 'void' ? (
        <DocumentReviseDialog
          purchaseOrderId={purchaseOrder.id}
          attachment={dialog.attachment}
          mode={dialog.type}
          onClose={closeDialog}
          onSaved={handleSaved}
        />
      ) : null}
    </section>
  );
}
