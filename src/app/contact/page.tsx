"use client"; // これを追加

import React, { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { SingleSelect } from '@/components/ui/SingleSelect';
import { TextAreaField } from '@/components/ui/TextAreaField';
import { TextField } from '@/components/ui/TextField';

export default function ContactPage() {
    const [selectedInquiryType, setSelectedInquiryType] = useState('');

    return (
        <div className="pb-10 min-h-screen flex items-start justify-center">
            <div className="w-full max-w-4xl mx-auto px-6 lg:px-12">
                <div className="mb-14 p-8 lg:p-10">
                    <h1 className="text-3xl text-black mb-2 tracking-tight font-display">Contact / お問い合わせ</h1>
                    <p className="text-base text-[#474747] leading-relaxed tracking-tight mb-8">ご質問やお問い合わせは、以下のフォームよりご連絡ください。</p>

                    <form className="space-y-6">
                        <TextField id="name" required label="NAME / お名前 *" type="text" name="name" size="md" className="w-full" />

                        <TextField id="email" required label="EMAIL / メールアドレス *" type="email" name="email" size="md" className="w-full" />

                        <SingleSelect
                            name="inquiry"
                            label="お問い合わせ内容"
                            value={selectedInquiryType}
                            onValueChange={(value) => setSelectedInquiryType(value)}
                            placeholder="選択してください"
                            options={[
                                { value: 'product', label: '商品について' },
                                { value: 'order', label: 'ご注文について' },
                                { value: 'other', label: 'その他' },
                            ]}
                            size="md"
                            variant="dropdown"
                            className="w-full"
                        />

                        <TextField id="subject" required label="SUBJECT / 件名 *" type="text" name="subject" size="md" className="w-full" />

                        <TextAreaField id="message" label="MESSAGE / メッセージ *" name="message" required rows={6} maxLength={500} size="md" className="w-full" />

                        <Button type="submit" size="lg" className="w-full ">SEND MESSAGE</Button>
                    </form>
                </div>
            </div>
        </div>
    );
}