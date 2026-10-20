"use client";

import React from "react";
import { Button } from "@/components/ui/Button/Button";
import { Checkbox } from "@/components/ui/Checkbox/Checkbox";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import { SingleSelect } from "@/components/ui/SingleSelect/SingleSelect";
import { TextAreaField } from "@/components/ui/TextAreaField/TextAreaField";
import { submitCustomerCancelRequest } from "@/features/account/returns/customer-return-client";
import {
  NOTE_MAX_LENGTH,
  REQUEST_TEXT,
} from "@/features/account/returns/return-request-model";

/** キャンセルのお申し込みで選べる品。注文の画面が、未発送の数が1以上の品だけを渡す */
export type CancelableLine = {
  orderItemId: string;
  /** 「{品名}（{色} / {サイズ}）」 */
  label: string;
  /** 未発送の数。選べる数の上限 */
  unshipped: number;
};

export type CancelRequestFormProps = {
  orderId: string;
  lines: CancelableLine[];
  /** 受け付けられた時（送り直しで前の申し込みが返った時も）。親が画面を閉じ、注文の答えを読み直す */
  onSubmitted: () => void;
  /** 「戻る」。結果が分からないまま戻る時は uncertain が true（受け付けられていたかもしれないので、親が読み直す） */
  onClose: (input: { uncertain: boolean }) => void;
};

/** 窓口へ送る中身（計画の冒頭 C-3）。二重防止の番号を含む */
type CancelRequestBody = {
  requestKey: string;
  lines: Array<{ orderItemId: string; quantity: number }>;
  customerNote: string | null;
};

// 見出しは注文の画面のカードの見出し（h2）と同じ書体にする（見出しの既定の書体は明朝）
const acuminFont = { fontFamily: "acumin-pro, sans-serif" } as const;

// 言葉は C-5。返品・交換の申し込みの画面と共通の言葉（数・戻る・申し込む・もう一度確かめる・結果が分からない時の文）は、
// Task 9 の REQUEST_TEXT から引いて、2つの画面でずれないようにする
const TITLE = "キャンセルのお申し込み";
const LINES_LABEL = "キャンセルする商品";
const NOTE_LABEL = `ご連絡事項（任意・${NOTE_MAX_LENGTH}字まで）`;
const NO_LINE_SELECTED = "キャンセルする商品を選んでください。";

/** 1〜未発送の数の選び肢 */
function quantityOptions(max: number) {
  return Array.from({ length: max }, (_, index) => {
    const value = String(index + 1);
    return { value, label: value };
  });
}

export function CancelRequestForm({
  orderId,
  lines,
  onSubmitted,
  onClose,
}: CancelRequestFormProps) {
  const titleId = React.useId();
  const linesId = React.useId();
  const titleRef = React.useRef<HTMLHeadingElement>(null);
  // 選んだ品と数。選んでいない品は持たない
  const [quantities, setQuantities] = React.useState<
    Partial<Record<string, number>>
  >({});
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  // 二重防止の番号。画面を開いた時に作り、窓口が断った時だけ作り直す
  const [requestKey, setRequestKey] = React.useState(() => crypto.randomUUID());
  // 結果が分からなかった時に送った中身。入っている間は入力を止め、「もう一度確かめる」が同じ中身で送り直す
  const [uncertainBody, setUncertainBody] =
    React.useState<CancelRequestBody | null>(null);

  // 欄の中に開くので、開いた時に題へフォーカスを移す（押したボタンは消えるため、そのままだとフォーカスが失われる）
  React.useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const frozen = busy || uncertainBody !== null;
  // 結果が分からない間に処理前の断りを受けた時は、断りの文の後ろに、結果が分からない時の文を続ける
  const alertText = error
    ? `${error}${uncertainBody ? REQUEST_TEXT.unknownOutcome : ""}`
    : uncertainBody
      ? REQUEST_TEXT.unknownOutcome
      : null;

  const toggle = (line: CancelableLine, checked: boolean) => {
    setError(null);
    setQuantities((current) => {
      const next = { ...current };
      if (checked) {
        next[line.orderItemId] = line.unshipped;
      } else {
        delete next[line.orderItemId];
      }
      return next;
    });
  };

  const send = async (body: CancelRequestBody) => {
    setBusy(true);
    setError(null);
    const result = await submitCustomerCancelRequest(orderId, body);
    setBusy(false);
    if (result.kind === "ok") {
      onSubmitted();
      return;
    }
    if (result.kind === "blocked") {
      // 今回は処理に入っていない（ログイン切れ・回数の制限）。番号・入力・結果が分からない状態を保つ
      setError(result.message);
      return;
    }
    if (result.kind === "refused") {
      // 窓口が断った＝記録していない。次の送信は別の操作なので、新しい番号にして入力を直せるようにする
      setRequestKey(crypto.randomUUID());
      setUncertainBody(null);
      setError(result.message);
      return;
    }
    // 通信の切れ・500番台・読めない答え。受け付けられたかもしれないので、同じ番号・同じ中身で確かめ直せるようにする
    setUncertainBody(body);
  };

  const handleSubmit = () => {
    if (busy || uncertainBody) {
      return;
    }
    const chosen = lines.flatMap((line) => {
      const quantity = quantities[line.orderItemId];
      return quantity === undefined
        ? []
        : [{ orderItemId: line.orderItemId, quantity }];
    });
    if (chosen.length === 0) {
      setError(NO_LINE_SELECTED);
      return;
    }
    const trimmed = note.trim();
    void send({
      requestKey,
      lines: chosen,
      customerNote: trimmed === "" ? null : trimmed,
    });
  };

  const handleRetry = () => {
    if (busy || !uncertainBody) {
      return;
    }
    void send(uncertainBody);
  };

  const handleBack = () => {
    if (busy) {
      return;
    }
    onClose({ uncertain: uncertainBody !== null });
  };

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      data-testid="cancel-request-form"
      className="space-y-4 border-t border-black/10 pt-4"
    >
      <h3
        id={titleId}
        ref={titleRef}
        tabIndex={-1}
        style={acuminFont}
        className="outline-none"
      >
        {TITLE}
      </h3>

      <div role="group" aria-labelledby={linesId} className="space-y-3">
        <p id={linesId} className="tracking-wider text-[#474747] lk-text-2xs">
          {LINES_LABEL}
        </p>
        {lines.map((line) => {
          const quantity = quantities[line.orderItemId];
          return (
            <div
              key={line.orderItemId}
              role="group"
              aria-label={line.label}
              className="space-y-2"
            >
              <Checkbox
                label={line.label}
                checked={quantity !== undefined}
                disabled={frozen}
                onChange={(event) => toggle(line, event.target.checked)}
              />
              {quantity !== undefined ? (
                <div className="pl-8">
                  <SingleSelect
                    label={REQUEST_TEXT.quantity}
                    options={quantityOptions(line.unshipped)}
                    value={String(quantity)}
                    disabled={frozen}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      setQuantities((current) => ({
                        ...current,
                        [line.orderItemId]: next,
                      }));
                    }}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <TextAreaField
        label={NOTE_LABEL}
        rows={3}
        maxLength={NOTE_MAX_LENGTH}
        value={note}
        disabled={frozen}
        onChange={(event) => setNote(event.target.value)}
      />

      <LiveMessage
        className="text-red-600 lk-text-sm"
        data-testid="cancel-request-error"
      >
        {alertText}
      </LiveMessage>

      {/* スマートフォンでは縦に並べる。見た目の順と操作（タブ）の順をそろえるため、並べ替えはしない */}
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="secondary"
          size="md"
          disabled={busy}
          onClick={handleBack}
        >
          {REQUEST_TEXT.back}
        </Button>
        {uncertainBody ? (
          <Button
            type="button"
            variant="primary"
            size="md"
            disabled={busy}
            onClick={handleRetry}
          >
            {REQUEST_TEXT.checkAgain}
          </Button>
        ) : (
          <Button
            type="button"
            variant="primary"
            size="md"
            disabled={busy}
            onClick={handleSubmit}
          >
            {REQUEST_TEXT.submit}
          </Button>
        )}
      </div>
    </div>
  );
}
