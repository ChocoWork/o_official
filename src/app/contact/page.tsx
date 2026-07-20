"use client"; // これを追加

import React, { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { SingleSelect } from "@/components/ui/SingleSelect/SingleSelect";
import { TextAreaField } from "@/components/ui/TextAreaField/TextAreaField";
import { TextField } from "@/components/ui/TextField/TextField";

type ContactFormData = {
  name: string;
  email: string;
  inquiryType: string;
  subject: string;
  orderNumber: string;
  message: string;
  website: string;
};

type FormErrors = Partial<Record<keyof ContactFormData, string>>;

const MAX_MESSAGE_LENGTH = 500;

export default function ContactPage() {
  const pageTitleStyle: React.CSSProperties = {
    fontSize: "var(--lk-size-4xl)",
  };
  const bodyTextStyle: React.CSSProperties = { fontSize: "var(--lk-size-md)" };
  const helperTextStyle: React.CSSProperties = {
    fontSize: "var(--lk-size-xs)",
  };
  const [formData, setFormData] = useState<ContactFormData>({
    name: "",
    email: "",
    inquiryType: "",
    subject: "",
    orderNumber: "",
    message: "",
    website: "",
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);
  const [showThanksModal, setShowThanksModal] = useState(false);
  const thanksDialogRef = useRef<HTMLDivElement>(null);

  const messageCount = formData.message.length;

  // サンクスモーダル: フォーカス移動・Tabトラップ・Escで閉じる・閉じたら元の要素へ復帰
  useEffect(() => {
    if (!showThanksModal) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    thanksDialogRef.current?.querySelector<HTMLElement>("button")?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowThanksModal(false);
        return;
      }
      if (event.key === "Tab") {
        const focusables =
          thanksDialogRef.current?.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          );
        if (!focusables || focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [showThanksModal]);

  const isFormValid =
    formData.name.trim().length > 0 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email) &&
    formData.inquiryType.trim().length > 0 &&
    formData.subject.trim().length > 0 &&
    formData.message.trim().length > 0 &&
    messageCount <= MAX_MESSAGE_LENGTH;

  const validate = (): FormErrors => {
    const nextErrors: FormErrors = {};

    if (!formData.name.trim()) {
      nextErrors.name = "お名前を入力してください。";
    }

    if (!formData.email.trim()) {
      nextErrors.email = "メールアドレスを入力してください。";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      nextErrors.email = "正しいメールアドレス形式で入力してください。";
    }

    if (!formData.inquiryType.trim()) {
      nextErrors.inquiryType = "お問い合わせ内容を選択してください。";
    }

    if (!formData.subject.trim()) {
      nextErrors.subject = "件名を入力してください。";
    }

    if (!formData.message.trim()) {
      nextErrors.message = "メッセージを入力してください。";
    } else if (formData.message.length > MAX_MESSAGE_LENGTH) {
      nextErrors.message = `メッセージは${MAX_MESSAGE_LENGTH}文字以内で入力してください。`;
    }

    return nextErrors;
  };

  const validateField = (
    fieldName: keyof ContactFormData,
    value: string,
  ): string | undefined => {
    const trimmed = value.trim();

    if (fieldName === "name" && !trimmed) {
      return "お名前を入力してください。";
    }

    if (fieldName === "email") {
      if (!trimmed) {
        return "メールアドレスを入力してください。";
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        return "正しいメールアドレス形式で入力してください。";
      }
    }

    if (fieldName === "inquiryType" && !trimmed) {
      return "お問い合わせ内容を選択してください。";
    }

    if (fieldName === "subject" && !trimmed) {
      return "件名を入力してください。";
    }

    if (fieldName === "message") {
      if (!trimmed) {
        return "メッセージを入力してください。";
      }
      if (value.length > MAX_MESSAGE_LENGTH) {
        return `メッセージは${MAX_MESSAGE_LENGTH}文字以内で入力してください。`;
      }
    }

    return undefined;
  };

  const handleFieldChange = (
    fieldName: keyof ContactFormData,
    value: string,
  ) => {
    setFormData((prev) => ({ ...prev, [fieldName]: value }));
    setErrors((prev) => ({ ...prev, [fieldName]: undefined }));
  };

  const handleFieldBlur = (fieldName: keyof ContactFormData, value: string) => {
    const error = validateField(fieldName, value);
    setErrors((prev) => ({ ...prev, [fieldName]: error }));
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitError(null);
    setSubmitSuccess(null);

    const validationErrors = validate();
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(formData),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok || !payload.success) {
        throw new Error(
          payload.error ??
            "送信に失敗しました。時間をおいて再度お試しください。",
        );
      }

      setSubmitSuccess("送信完了しました。お問い合わせありがとうございます。");
      setShowThanksModal(true);
      setFormData({
        name: "",
        email: "",
        inquiryType: "",
        subject: "",
        orderNumber: "",
        message: "",
        website: "",
      });
      setErrors({});
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "送信に失敗しました。",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const fieldDescribedBy = (name: keyof ContactFormData) =>
    errors[name] ? `${name}-error` : undefined;

  return (
    <div className="w-full max-w-[680px] mx-auto">
      <div className="space-y-2 sm:space-y-3">
        <h1 style={pageTitleStyle}>Contact / お問い合わせ</h1>
        <p
          className="text-[#474747] leading-relaxed tracking-tight"
          style={helperTextStyle}
        >
          内容を確認のうえ、通常3営業日以内に担当者よりご返信いたします。お急ぎの場合や返信が届かない場合は、迷惑メールフォルダーもご確認ください。
        </p>
      </div>

      <div className="mt-8 sm:mt-10 lg:mt-12 pb-8 sm:pb-10">
        <form className="space-y-6" onSubmit={handleSubmit} noValidate>
          <input
            type="text"
            name="website"
            value={formData.website}
            onChange={(event) =>
              handleFieldChange("website", event.target.value)
            }
            autoComplete="off"
            tabIndex={-1}
            aria-hidden="true"
            className="hidden"
          />

          <TextField
            id="name"
            required
            label="NAME / お名前 *"
            type="text"
            name="name"
            size="sm"
            className="w-full"
            value={formData.name}
            onChange={(event) => handleFieldChange("name", event.target.value)}
            onBlur={(event) => handleFieldBlur("name", event.target.value)}
            errorText={errors.name}
            aria-describedby={fieldDescribedBy("name")}
            aria-invalid={Boolean(errors.name)}
          />

          <TextField
            id="email"
            required
            label="EMAIL / メールアドレス *"
            type="email"
            name="email"
            size="sm"
            className="w-full"
            value={formData.email}
            onChange={(event) => handleFieldChange("email", event.target.value)}
            onBlur={(event) => handleFieldBlur("email", event.target.value)}
            errorText={errors.email}
            aria-describedby={fieldDescribedBy("email")}
            aria-invalid={Boolean(errors.email)}
          />

          <SingleSelect
            name="inquiryType"
            label="お問い合わせ内容"
            value={formData.inquiryType}
            onValueChange={(value) => {
              handleFieldChange("inquiryType", value);
              handleFieldBlur("inquiryType", value);
            }}
            placeholder="選択してください"
            options={[
              { value: "product", label: "商品について" },
              { value: "order", label: "ご注文について" },
              { value: "other", label: "その他" },
            ]}
            size="sm"
            variant="dropdown"
            block
            className="w-full"
            aria-describedby={fieldDescribedBy("inquiryType")}
            aria-invalid={Boolean(errors.inquiryType)}
          />
          {errors.inquiryType ? (
            <p
              id="inquiryType-error"
              className="text-xs text-red-600"
              role="alert"
            >
              {errors.inquiryType}
            </p>
          ) : null}

          <TextField
            id="subject"
            required
            label="SUBJECT / 件名 *"
            type="text"
            name="subject"
            size="sm"
            className="w-full"
            value={formData.subject}
            onChange={(event) =>
              handleFieldChange("subject", event.target.value)
            }
            onBlur={(event) => handleFieldBlur("subject", event.target.value)}
            errorText={errors.subject}
            aria-describedby={fieldDescribedBy("subject")}
            aria-invalid={Boolean(errors.subject)}
          />

          <div>
            <TextField
              id="orderNumber"
              label="ORDER NO. / 注文番号（任意）"
              type="text"
              name="orderNumber"
              size="sm"
              className="w-full"
              placeholder="ORD-XXXXXXXX"
              value={formData.orderNumber}
              onChange={(event) =>
                handleFieldChange("orderNumber", event.target.value)
              }
              aria-describedby="orderNumber-help"
            />
          </div>

          <div>
            <TextAreaField
              id="message"
              label="MESSAGE / メッセージ *"
              name="message"
              required
              rows={6}
              maxLength={MAX_MESSAGE_LENGTH}
              size="sm"
              className="w-full"
              value={formData.message}
              onChange={(event) =>
                handleFieldChange("message", event.target.value)
              }
              onBlur={(event) => handleFieldBlur("message", event.target.value)}
              aria-describedby={
                fieldDescribedBy("message")
                  ? `${fieldDescribedBy("message")} message-counter`
                  : "message-counter"
              }
              aria-invalid={Boolean(errors.message)}
            />
            <div className="mt-1.5 flex items-center justify-between">
              {errors.message ? (
                <p
                  id="message-error"
                  className="text-xs text-red-600"
                  role="alert"
                  style={helperTextStyle}
                >
                  {errors.message}
                </p>
              ) : (
                <span />
              )}
              <p
                id="message-counter"
                className="text-xs text-[#474747]"
                style={helperTextStyle}
              >
                {messageCount} / {MAX_MESSAGE_LENGTH}
              </p>
            </div>
          </div>

          {submitSuccess ? (
            <p
              className="text-sm flex items-center gap-2"
              role="status"
              style={bodyTextStyle}
            >
              <span aria-hidden="true">✓</span>
              {submitSuccess}
            </p>
          ) : null}
          {submitError ? (
            <p
              className="text-sm text-red-600"
              role="alert"
              style={bodyTextStyle}
            >
              {submitError}
            </p>
          ) : null}

          <Button
            type="submit"
            size="lg"
            className="w-full "
            disabled={!isFormValid || isSubmitting}
          >
            {isSubmitting ? "SENDING..." : "SEND MESSAGE"}
          </Button>
        </form>
      </div>

      {showThanksModal ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setShowThanksModal(false)}
        >
          <div
            ref={thanksDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="thanks-modal-title"
            className="w-full max-w-md bg-white p-6 sm:p-8 text-center space-y-4"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="thanks-modal-title">お問い合わせありがとうございます</h3>
            <p className="text-sm text-[#474747]" style={bodyTextStyle}>
              内容を確認のうえ、担当者よりご連絡いたします。
            </p>
            <Button
              type="button"
              size="md"
              className="w-full"
              onClick={() => setShowThanksModal(false)}
            >
              閉じる
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
