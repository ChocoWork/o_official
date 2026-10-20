'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { LiveMessage } from '@/components/ui/LiveMessage/LiveMessage';
import { SingleSelect } from '@/components/ui/SingleSelect/SingleSelect';
import { TextAreaField } from '@/components/ui/TextAreaField/TextAreaField';
import { ReturnPhotoPicker } from '@/features/account/returns/ReturnPhotoPicker';
import { ReturnRequestAccepted, ReturnRequestConfirm } from '@/features/account/returns/ReturnRequestConfirm';
import {
  EMPTY_LINE_INPUT,
  NOTE_MAX_LENGTH,
  REQUEST_TEXT,
  buildConfirmSummary,
  buildSubmitBody,
  firstErrorFieldId,
  formatMonthDay,
  hasSendingPhotos,
  isNoteRequired,
  isSelectableLine,
  itemLabel,
  lineDomId,
  lineKey,
  normalizeLine,
  reasonOptionsOf,
  reasonSettingOf,
  resolutionOptionsOf,
  exchangeVariantsOf,
  validateDraft,
  variantChoicesOf,
  variantText,
  type ConfirmSummary,
  type LineErrors,
  type LineInput,
  type PickedPhoto,
  type RequestDraft,
  type RequestLine,
  type RequestPhotos,
  type SubmitBody,
} from '@/features/account/returns/return-request-model';
import { toOrderNumber } from '@/lib/orders/order-number';
import { CUSTOMER_RETURN_LINE_STATE_LABELS } from '@/lib/orders/returns/customer-return-messages';
import type { CustomerReturnRequestMaterials } from '@/lib/orders/returns/customer-return-types';
import { RETURN_REASON_LABELS } from '@/lib/orders/returns/return-messages';
import type { ReturnResolution } from '@/lib/orders/returns/return-types';

type Step = 'select' | 'confirm' | 'done';

/** 手順1の下の誤りの文（role="alert"）。写真の断りで手順1へ戻った時に、フォーカスを移す */
const FORM_ALERT_ID = 'return-request-form-alert';

type RequestLineItemProps = {
  materials: CustomerReturnRequestMaterials;
  line: RequestLine;
  idPrefix: string;
  input: LineInput;
  photos: PickedPhoto[];
  errors: LineErrors;
  onChange: (patch: Partial<LineInput>) => void;
  onPhotosChange: (update: (previous: PickedPhoto[]) => PickedPhoto[]) => void;
};

const RESOLUTION_LABELS: Record<ReturnResolution, string> = {
  refund: REQUEST_TEXT.wishRefund,
  exchange: REQUEST_TEXT.wishExchange,
};

/** 発送の行1つ。選べない行は理由の言葉だけ、選べる行は選ぶチェックと、選んだ後の入力を出す */
function RequestLineItem({ materials, line, idPrefix, input, photos, errors, onChange, onPhotosChange }: RequestLineItemProps) {
  const label = itemLabel(line.itemName, line.color, line.size);
  const selectable = isSelectableLine(line);
  const reasonOptions = selectable ? reasonOptionsOf(materials, line) : [];
  const setting = reasonSettingOf(materials, input.reason);
  const exchangeUsable = exchangeVariantsOf(materials, line.itemId).length > 0;
  const resolutionOptions = setting ? resolutionOptionsOf(setting.resolutions, exchangeUsable) : [];
  const variantChoices = setting ? variantChoicesOf(materials, line, setting, input.quantity) : [];
  const noteRequired = setting ? isNoteRequired(setting.reason) : false;

  return (
    <li>
      <div role="group" aria-label={label} className="min-w-0 space-y-3 border border-black/10 p-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 break-words font-acumin lk-text-sm text-black">{label}</span>
          {line.lineKind === 'exchange' ? <span className="account-status account-status-sm">{REQUEST_TEXT.exchangeBadge}</span> : null}
        </div>
        {line.returnIneligible ? <p className="break-words font-acumin lk-text-3xs text-[#474747]">{REQUEST_TEXT.ineligible}</p> : null}
        {!selectable ? (
          <p className="break-words font-acumin lk-text-3xs text-[#474747]">
            {CUSTOMER_RETURN_LINE_STATE_LABELS[line.state === 'selectable' ? 'unavailable' : line.state]}
          </p>
        ) : (
          <>
            <Checkbox
              id={`${idPrefix}-select`}
              label={REQUEST_TEXT.selectItem}
              checked={input.selected}
              disabled={reasonOptions.length === 0}
              onChange={(event) => onChange({ selected: event.target.checked })}
            />
            {input.selected ? (
              <div className="min-w-0 space-y-4 border-l border-black/10 pl-4">
                <SingleSelect
                  id={`${idPrefix}-quantity`}
                  label={REQUEST_TEXT.quantity}
                  options={Array.from({ length: line.selectable }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }))}
                  value={String(input.quantity)}
                  onChange={(event) => onChange({ quantity: Number(event.target.value) })}
                />
                <SingleSelect
                  id={`${idPrefix}-reason`}
                  label={REQUEST_TEXT.reason}
                  placeholder={REQUEST_TEXT.reasonPlaceholder}
                  options={reasonOptions.map((option) => ({ value: option.reason, label: RETURN_REASON_LABELS[option.reason] }))}
                  value={input.reason}
                  errorText={errors.reason}
                  onChange={(event) => onChange({ reason: reasonOptions.find((option) => option.reason === event.target.value)?.reason ?? '' })}
                />
                {setting ? (
                  <>
                    <TextAreaField
                      id={`${idPrefix}-note`}
                      label={REQUEST_TEXT.note(noteRequired)}
                      value={input.note}
                      rows={3}
                      maxLength={NOTE_MAX_LENGTH}
                      errorText={errors.note}
                      onChange={(event) => onChange({ note: event.target.value })}
                    />
                    {setting.photo !== 'none' ? (
                      <ReturnPhotoPicker
                        idPrefix={idPrefix}
                        orderId={materials.order.id}
                        rule={setting.photo}
                        instructions={setting.photoInstructions}
                        photos={photos}
                        onPhotosChange={onPhotosChange}
                        errorText={errors.photos}
                      />
                    ) : null}
                    <SingleSelect
                      id={`${idPrefix}-resolution`}
                      label={REQUEST_TEXT.wish}
                      options={resolutionOptions.map((resolution) => ({ value: resolution, label: RESOLUTION_LABELS[resolution] }))}
                      value={input.resolution}
                      disabled={resolutionOptions.length === 1}
                      onChange={(event) => onChange({ resolution: event.target.value === 'exchange' ? 'exchange' : 'refund' })}
                    />
                    {input.resolution === 'exchange' ? (
                      <div className="min-w-0 space-y-2">
                        <SingleSelect
                          id={`${idPrefix}-variant`}
                          label={REQUEST_TEXT.exchangeVariant}
                          placeholder={REQUEST_TEXT.reasonPlaceholder}
                          options={variantChoices
                            .filter((choice) => choice.status !== 'unavailable')
                            .map((choice) => ({
                              value: String(choice.variant.variantId),
                              label: variantText(choice.variant.color, choice.variant.size) || line.itemName,
                            }))}
                          value={input.variantId}
                          errorText={errors.variant}
                          onChange={(event) => onChange({ variantId: event.target.value })}
                        />
                        <ul className="space-y-1 font-acumin lk-text-3xs text-[#474747]">
                          {variantChoices
                            .filter((choice) => choice.status !== 'in_stock')
                            .map((choice) => (
                              <li key={choice.variant.variantId} className="break-words">
                                {`${variantText(choice.variant.color, choice.variant.size) || line.itemName}: ${
                                  choice.status === 'make' ? REQUEST_TEXT.makeToOrder(choice.variant.madeToOrderLeadDays) : REQUEST_TEXT.outOfStock
                                }`}
                              </li>
                            ))}
                        </ul>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </li>
  );
}

/**
 * お客様の返品・交換の申し込み（グループ E-3 段2。共通の約束 C-5・P7）。「1. 商品を選ぶ」→「2. 内容を確かめる」→「3. お申し込みの受付」の3段。
 * この部品が3段の入力と段を持ち、確かめる段と受け付けた段は ReturnRequestConfirm.tsx の部品が描く。
 * ご希望（返金か交換）は商品の行ごとに1つ。写真は送り終えた物の送り先の番号だけを窓口へ送る。
 * 「内容を確かめる」を押した時に入力を確かめ、通ったら二重防止の番号を作って確かめる段へ移る（P13）。
 * 戻って直しても入力と写真は残り、確かめる段に入り直すたびに新しい番号になる。
 */
export function ReturnRequestForm({ materials }: { materials: CustomerReturnRequestMaterials }) {
  const orderId = materials.order.id;
  const [step, setStep] = useState<Step>('select');
  const [draft, setDraft] = useState<RequestDraft>({});
  const [photos, setPhotos] = useState<RequestPhotos>({});
  const [attempted, setAttempted] = useState(false);
  const [photoNotice, setPhotoNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ body: SubmitBody; summary: ConfirmSummary } | null>(null);
  const [acceptedLabel, setAcceptedLabel] = useState<string | null>(null);

  const validation = validateDraft(materials, draft, photos);
  // 写真の欄を出している行の、送っている途中の写真だけを見る（隠れた欄の写真で、理由の見えないまま止めない）
  const hasSending = hasSendingPhotos(materials, draft, photos);
  const formAlert = photoNotice ?? (attempted && validation.noneSelected ? REQUEST_TEXT.noneSelected : null);
  const stepIndex = step === 'select' ? 0 : step === 'confirm' ? 1 : 2;

  // 写真の断りで手順1へ戻った時は、押したボタンが消えて位置が失われ、文が見えない所にあるかもしれないので、文へフォーカスを移す
  useEffect(() => {
    if (step === 'select' && photoNotice !== null) document.getElementById(FORM_ALERT_ID)?.focus();
  }, [step, photoNotice]);

  const updateLine = (key: string, line: RequestLine, patch: Partial<LineInput>) => {
    setDraft((previous) => ({
      ...previous,
      [key]: normalizeLine(materials, line, { ...(previous[key] ?? EMPTY_LINE_INPUT), ...patch }),
    }));
  };

  const updatePhotos = (key: string, update: (previous: PickedPhoto[]) => PickedPhoto[]) => {
    setPhotos((previous) => ({ ...previous, [key]: update(previous[key] ?? []) }));
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (hasSending) return;
    setAttempted(true);
    setPhotoNotice(null);
    if (!validation.valid) {
      const fieldId = firstErrorFieldId(materials, validation);
      if (fieldId) document.getElementById(fieldId)?.focus();
      return;
    }
    // 二重防止の番号は、確かめる段に入る時に作る（入力を直して入り直せば、新しい番号になる）
    setConfirmation({
      body: buildSubmitBody(materials, draft, photos, crypto.randomUUID()),
      summary: buildConfirmSummary(materials, draft, photos),
    });
    setStep('confirm');
  };

  const backToSelect = () => {
    setConfirmation(null);
    setStep('select');
  };

  const accept = ({ label }: { label: string }) => {
    setConfirmation(null);
    setAcceptedLabel(label);
    setStep('done');
  };

  // 窓口が「合わない写真」と断った時: 合わないと分かった写真を外して最初の段へ戻し、文を出して選び直してもらう
  // （DB が断って合わない写真が分からない時は、写真を残して文だけ出す）
  const rejectPhotos = (uploadIds: string[], message: string) => {
    const rejected = (photo: PickedPhoto) => photo.uploadId !== null && uploadIds.includes(photo.uploadId);
    setPhotos((previous) =>
      Object.fromEntries(Object.entries(previous).map(([key, list]) => [key, list.filter((photo) => !rejected(photo))])),
    );
    setPhotoNotice(message);
    setAttempted(true);
    backToSelect();
  };

  const notice = materials.noticeText.trim() === '' || step === 'done' ? null : materials.noticeText;

  return (
    <div className="min-w-0 space-y-6">
      <div className="space-y-4">
        <p className="font-acumin lk-text-sm text-[#474747]">{REQUEST_TEXT.orderNumber(toOrderNumber(orderId))}</p>
        {/* list-none で書体を消した一覧は、Safari の VoiceOver で一覧として読まれないことがあるので role="list" を付ける（ほかの画面にも前例） */}
        <ol role="list" aria-label={REQUEST_TEXT.stepsLabel} className="flex list-none flex-col gap-1 p-0 sm:flex-row sm:gap-6">
          {REQUEST_TEXT.stepLabels.map((stepLabel, index) => (
            <li
              key={stepLabel}
              aria-current={index === stepIndex ? 'step' : undefined}
              className={`font-acumin lk-text-sm ${index === stepIndex ? 'text-black' : 'text-[#999]'}`}
            >
              {stepLabel}
            </li>
          ))}
        </ol>
        {notice ? (
          <p data-testid="return-request-notice" className="whitespace-pre-wrap break-words border border-black/10 p-4 font-acumin lk-text-sm text-black">
            {notice}
          </p>
        ) : null}
      </div>

      {step === 'select' ? (
        <form className="min-w-0 space-y-6" noValidate onSubmit={handleSubmit}>
          {materials.shipments.map((shipment) => {
            const heading = REQUEST_TEXT.shipmentHeading(shipment.number, formatMonthDay(shipment.shippedAt));
            return (
              <section key={shipment.fulfillmentId} aria-label={heading} className="min-w-0 space-y-4 border border-black/10 p-5 sm:p-8">
                <h2 className="font-acumin">{heading}</h2>
                <p className="font-acumin lk-text-3xs text-[#474747]">{REQUEST_TEXT.deadline(shipment.deadlineDate)}</p>
                <ul className="space-y-4">
                  {shipment.lines.map((line) => {
                    const key = lineKey(shipment.fulfillmentId, line.orderItemId);
                    return (
                      <RequestLineItem
                        key={key}
                        materials={materials}
                        line={line}
                        idPrefix={lineDomId(key)}
                        input={draft[key] ?? EMPTY_LINE_INPUT}
                        photos={photos[key] ?? []}
                        errors={attempted ? (validation.lines[key] ?? {}) : {}}
                        onChange={(patch) => updateLine(key, line, patch)}
                        onPhotosChange={(update) => updatePhotos(key, update)}
                      />
                    );
                  })}
                </ul>
              </section>
            );
          })}
          <LiveMessage id={FORM_ALERT_ID} tabIndex={-1} className="font-acumin lk-text-sm text-red-600 outline-none">
            {formAlert}
          </LiveMessage>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button href={`/account/orders/${orderId}`} variant="secondary" size="md" className="w-full font-acumin sm:w-auto">
              {REQUEST_TEXT.toOrder}
            </Button>
            <Button type="submit" variant="primary" size="md" className="w-full font-acumin sm:w-auto" disabled={hasSending}>
              {REQUEST_TEXT.check}
            </Button>
          </div>
        </form>
      ) : null}

      {step === 'confirm' && confirmation ? (
        <ReturnRequestConfirm
          orderId={orderId}
          body={confirmation.body}
          summary={confirmation.summary}
          onBack={backToSelect}
          onAccepted={accept}
          onPhotosRejected={rejectPhotos}
        />
      ) : null}

      {step === 'done' && acceptedLabel !== null ? <ReturnRequestAccepted orderId={orderId} label={acceptedLabel} /> : null}
    </div>
  );
}
