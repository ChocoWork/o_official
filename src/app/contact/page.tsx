"use client"; // これを追加

import React, { useState } from 'react';

export default function ContactPage() {
    const [selectedInquiryType, setSelectedInquiryType] = useState('');

    const handleInquiryChange = (event) => {
        setSelectedInquiryType(event.target.value);
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
                            <div>
                                <label htmlFor="name" className="block text-sm tracking-widest mb-2">NAME *</label>
                                <input id="name" required className="w-full px-4 py-3 border border-black/20 focus:border-black outline-none transition-colors duration-300 text-sm" type="text" name="name" />
                            </div>

                            <div>
                                <label htmlFor="email" className="block text-sm tracking-widest mb-2">EMAIL *</label>
                                <input id="email" required className="w-full px-4 py-3 border border-black/20 focus:border-black outline-none transition-colors duration-300 text-sm" type="email" name="email" />
                            </div>

                            <div>
                                <label htmlFor="subject" className="block text-sm tracking-widest mb-2">SUBJECT *</label>
                                <input id="subject" required className="w-full px-4 py-3 border border-black/20 focus:border-black outline-none transition-colors duration-300 text-sm" type="text" name="subject" />
                            </div>

                            <div>
                                <label htmlFor="message" className="block text-sm tracking-widest mb-2">MESSAGE *</label>
                                <textarea id="message" name="message" required rows={6} maxLength={500} className="w-full px-4 py-3 border border-black/20 focus:border-black outline-none transition-colors duration-300 resize-none text-sm"></textarea>
                            </div>

                            <button type="submit" className="w-full py-4 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap">SEND MESSAGE</button>
                        </form>
                    </div>
                </div>
            </div>
        </main>
    );
}