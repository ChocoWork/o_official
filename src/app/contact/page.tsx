"use client"; // これを追加

import React, { useState } from 'react';
import { Button } from '@/app/components/ui/Button';
import { RadioButtonGroup } from '@/app/components/ui/RadioButtonGroup';
import { TextAreaField } from '@/app/components/ui/TextAreaField';
import { TextField } from '@/app/components/ui/TextField';

export default function ContactPage() {
    const [selectedInquiryType, setSelectedInquiryType] = useState('');

    const handleInquiryChange = (value: string) => {
        setSelectedInquiryType(value);
    };

    return (
        <main className="pt-32 pb-20">
            <div className="max-w-4xl mx-auto px-6 lg:px-12">
                <div className="mb-16">
                    <h1 className="text-4xl lg:text-5xl text-black mb-6 tracking-tight">Contact</h1>
                    <p className="text-base text-[#474747] leading-relaxed">ご質問やお問い合わせは、以下のフォームよりお気軽にご連絡ください。</p>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 mb-16">
                    <div>
                        <h2 className="text-2xl text-black mb-6 tracking-tight">Get in Touch</h2>
                        <div className="space-y-6">
                            <div>
                                <h3 className="text-sm tracking-widest mb-2">EMAIL</h3>
                                <a href="mailto:info@lefildesheures.com" className="text-base text-[#474747] hover:text-black transition-colors duration-300">info@lefildesheures.com</a>
                            </div>
                            <div>
                                <h3 className="text-sm tracking-widest mb-2">PHONE</h3>
                                <p className="text-base text-[#474747]">03-1234-5678</p>
                            </div>
                            <div>
                                <h3 className="text-sm tracking-widest mb-2">ADDRESS</h3>
                                <p className="text-base text-[#474747]">東京都港区南青山3-14-15</p>
                            </div>
                            <div>
                                <h3 className="text-sm tracking-widest mb-2">BUSINESS HOURS</h3>
                                <p className="text-base text-[#474747]">月〜金: 10:00 - 18:00<br />土日祝: 定休日</p>
                            </div>
                        </div>
                    </div>

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
                            />

                            <TextField id="name" required label="NAME *" type="text" name="name" />

                            <TextField id="email" required label="EMAIL *" type="email" name="email" />

                            <TextField id="subject" required label="SUBJECT *" type="text" name="subject" />

                            <TextAreaField id="message" label="MESSAGE *" name="message" required rows={6} maxLength={500} />

                            <Button type="submit" size="lg" className="w-full">SEND MESSAGE</Button>
                        </form>
                    </div>
                </div>
            </div>
        </main>
    );
}