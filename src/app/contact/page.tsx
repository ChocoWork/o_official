"use client"; // これを追加

import React, { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { SingleSelect } from '@/components/ui/SingleSelect';
import { TextAreaField } from '@/components/ui/TextAreaField';
import { TextField } from '@/components/ui/TextField';

type ContactFormData = {
    name: string;
    email: string;
    inquiryType: string;
    subject: string;
    message: string;
    website: string;
};

type FormErrors = Partial<Record<keyof ContactFormData, string>>;

const MAX_MESSAGE_LENGTH = 500;

export default function ContactPage() {
    const [formData, setFormData] = useState<ContactFormData>({
        name: '',
        email: '',
        inquiryType: '',
        subject: '',
        message: '',
        website: '',
    });
    const [errors, setErrors] = useState<FormErrors>({});
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);
    const [showThanksModal, setShowThanksModal] = useState(false);

    const messageCount = formData.message.length;

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
            nextErrors.name = 'お名前を入力してください。';
        }

        if (!formData.email.trim()) {
            nextErrors.email = 'メールアドレスを入力してください。';
        } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
            nextErrors.email = '正しいメールアドレス形式で入力してください。';
        }

        if (!formData.inquiryType.trim()) {
            nextErrors.inquiryType = 'お問い合わせ内容を選択してください。';
        }

        if (!formData.subject.trim()) {
            nextErrors.subject = '件名を入力してください。';
        }

        if (!formData.message.trim()) {
            nextErrors.message = 'メッセージを入力してください。';
        } else if (formData.message.length > MAX_MESSAGE_LENGTH) {
            nextErrors.message = `メッセージは${MAX_MESSAGE_LENGTH}文字以内で入力してください。`;
        }

        return nextErrors;
    };

    const validateField = (fieldName: keyof ContactFormData, value: string): string | undefined => {
        const trimmed = value.trim();

        if (fieldName === 'name' && !trimmed) {
            return 'お名前を入力してください。';
        }

        if (fieldName === 'email') {
            if (!trimmed) {
                return 'メールアドレスを入力してください。';
            }
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
                return '正しいメールアドレス形式で入力してください。';
            }
        }

        if (fieldName === 'inquiryType' && !trimmed) {
            return 'お問い合わせ内容を選択してください。';
        }

        if (fieldName === 'subject' && !trimmed) {
            return '件名を入力してください。';
        }

        if (fieldName === 'message') {
            if (!trimmed) {
                return 'メッセージを入力してください。';
            }
            if (value.length > MAX_MESSAGE_LENGTH) {
                return `メッセージは${MAX_MESSAGE_LENGTH}文字以内で入力してください。`;
            }
        }

        return undefined;
    };

    const handleFieldChange = (fieldName: keyof ContactFormData, value: string) => {
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
            const response = await fetch('/api/contact', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(formData),
            });

            const payload = await response.json().catch(() => ({}));

            if (!response.ok || !payload.success) {
                throw new Error(payload.error ?? '送信に失敗しました。時間をおいて再度お試しください。');
            }

            setSubmitSuccess('送信完了しました。お問い合わせありがとうございます。');
            setShowThanksModal(true);
            setFormData({
                name: '',
                email: '',
                inquiryType: '',
                subject: '',
                message: '',
                website: '',
            });
            setErrors({});
        } catch (error) {
            setSubmitError(error instanceof Error ? error.message : '送信に失敗しました。');
        } finally {
            setIsSubmitting(false);
        }
    };

    const fieldDescribedBy = (name: keyof ContactFormData) => (errors[name] ? `${name}-error` : undefined);

    return (
        <div className="pb-10 min-h-screen flex items-start justify-center">
            <div className="w-full max-w-4xl mx-auto px-4 sm:px-6 lg:px-12">
                <div className="mb-6 sm:mb-14 p-4 sm:p-8 lg:p-10">
                    <h1 className="text-xl sm:text-2xl lg:text-3xl text-black mb-2 tracking-tight font-display">Contact / お問い合わせ</h1>
                    <p className="text-sm lg:text-base text-[#474747] leading-relaxed tracking-tight mb-4 sm:mb-8">ご質問やお問い合わせは、以下のフォームよりご連絡ください。</p>

                    <form className="space-y-6" onSubmit={handleSubmit} noValidate>
                        <input
                            type="text"
                            name="website"
                            value={formData.website}
                            onChange={(event) => handleFieldChange('website', event.target.value)}
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
                            size="md"
                            className="w-full"
                            value={formData.name}
                            onChange={(event) => handleFieldChange('name', event.target.value)}
                            onBlur={(event) => handleFieldBlur('name', event.target.value)}
                            errorText={errors.name}
                            aria-describedby={fieldDescribedBy('name')}
                            aria-invalid={Boolean(errors.name)}
                        />
                        {errors.name ? <p id="name-error" className="text-xs text-red-600" role="alert">{errors.name}</p> : null}

                        <TextField
                            id="email"
                            required
                            label="EMAIL / メールアドレス *"
                            type="email"
                            name="email"
                            size="md"
                            className="w-full"
                            value={formData.email}
                            onChange={(event) => handleFieldChange('email', event.target.value)}
                            onBlur={(event) => handleFieldBlur('email', event.target.value)}
                            errorText={errors.email}
                            aria-describedby={fieldDescribedBy('email')}
                            aria-invalid={Boolean(errors.email)}
                        />
                        {errors.email ? <p id="email-error" className="text-xs text-red-600" role="alert">{errors.email}</p> : null}

                        <SingleSelect
                            name="inquiry"
                            label="お問い合わせ内容"
                            value={formData.inquiryType}
                            onValueChange={(value) => {
                                handleFieldChange('inquiryType', value);
                                handleFieldBlur('inquiryType', value);
                            }}
                            placeholder="選択してください"
                            options={[
                                { value: 'product', label: '商品について' },
                                { value: 'order', label: 'ご注文について' },
                                { value: 'other', label: 'その他' },
                            ]}
                            size="md"
                            variant="dropdown"
                            className="w-full"
                            aria-describedby={fieldDescribedBy('inquiryType')}
                            aria-invalid={Boolean(errors.inquiryType)}
                        />
                        {errors.inquiryType ? <p id="inquiryType-error" className="text-xs text-red-600" role="alert">{errors.inquiryType}</p> : null}

                        <TextField
                            id="subject"
                            required
                            label="SUBJECT / 件名 *"
                            type="text"
                            name="subject"
                            size="md"
                            className="w-full"
                            value={formData.subject}
                            onChange={(event) => handleFieldChange('subject', event.target.value)}
                            onBlur={(event) => handleFieldBlur('subject', event.target.value)}
                            errorText={errors.subject}
                            aria-describedby={fieldDescribedBy('subject')}
                            aria-invalid={Boolean(errors.subject)}
                        />
                        {errors.subject ? <p id="subject-error" className="text-xs text-red-600" role="alert">{errors.subject}</p> : null}

                        <TextAreaField
                            id="message"
                            label="MESSAGE / メッセージ *"
                            name="message"
                            required
                            rows={6}
                            maxLength={MAX_MESSAGE_LENGTH}
                            size="md"
                            className="w-full"
                            value={formData.message}
                            onChange={(event) => handleFieldChange('message', event.target.value)}
                            onBlur={(event) => handleFieldBlur('message', event.target.value)}
                            aria-describedby={fieldDescribedBy('message') ? `${fieldDescribedBy('message')} message-counter` : 'message-counter'}
                            aria-invalid={Boolean(errors.message)}
                        />
                        <div className="flex items-center justify-between">
                            {errors.message ? <p id="message-error" className="text-xs text-red-600" role="alert">{errors.message}</p> : <span />}
                            <p id="message-counter" className="text-xs text-[#474747]">{messageCount} / {MAX_MESSAGE_LENGTH}</p>
                        </div>

                        {submitSuccess ? <p className="text-sm text-green-700" role="status">{submitSuccess}</p> : null}
                        {submitError ? <p className="text-sm text-red-600" role="alert">{submitError}</p> : null}

                        <Button type="submit" size="lg" className="w-full " disabled={!isFormValid || isSubmitting}>
                            {isSubmitting ? 'SENDING...' : 'SEND MESSAGE'}
                        </Button>
                    </form>
                </div>
            </div>

            {showThanksModal ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="送信完了">
                    <div className="w-full max-w-md bg-white p-6 sm:p-8 text-center space-y-4">
                        <h2 className="text-xl text-black tracking-tight">お問い合わせありがとうございます</h2>
                        <p className="text-sm text-[#474747]">内容を確認のうえ、担当者よりご連絡いたします。</p>
                        <Button type="button" size="md" className="w-full" onClick={() => setShowThanksModal(false)}>
                            閉じる
                        </Button>
                    </div>
                </div>
            ) : null}
        </div>
    );
}