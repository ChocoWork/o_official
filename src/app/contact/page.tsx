"use client"; // これを追加

import React, { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { RadioButtonGroup } from '@/components/ui/RadioButtonGroup';
import { TextAreaField } from '@/components/ui/TextAreaField';
import { TextField } from '@/components/ui/TextField';

export default function ContactPage() {
    const [selectedInquiryType, setSelectedInquiryType] = useState('');

    const handleInquiryChange = (value: string) => {
        setSelectedInquiryType(value);
    };

    return (
        <main className="pt-32 pb-20">
            <div className="max-w-4xl mx-auto px-6 lg:px-12">
                <div className="mb-16">
                    <p className="text-base text-[#474747] leading-relaxed">ご質問やお問い合わせは、以下のフォームよりお気軽にご連絡ください。</p>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 mb-16">
                    <div>
                        <form className="space-y-6">
                            <RadioButtonGroup
                                name="inquiry"
                                value={selectedInquiryType}
                                onChange={handleInquiryChange}
                                direction="column"
                                options={[
                                    { value: 'product', label: '商品について' },
                                    { value: 'order', label: 'ご注文について' },
                                    { value: 'other', label: 'その他' },
                                ]}
                             size="md"/>

                            <TextField id="name" required label="NAME *" type="text" name="name"  size="md"/>

                            <TextField id="email" required label="EMAIL *" type="email" name="email"  size="md"/>

                            <TextField id="subject" required label="SUBJECT *" type="text" name="subject"  size="md"/>

                            <TextAreaField id="message" label="MESSAGE *" name="message" required rows={6} maxLength={500}  size="md"/>

                            <Button type="submit" size="lg" className="w-full">SEND MESSAGE</Button>
                        </form>
                    </div>
                </div>
            </div>
        </main>
    );
}