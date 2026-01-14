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
                    <h1 className="text-4xl lg:text-5xl text-black mb-6 tracking-tight" style={{ fontFamily: 'Didot, serif' }}>Contact</h1>
                    <p className="text-base text-[#474747] leading-relaxed" style={{ fontFamily: 'acumin-pro, sans-serif' }}>ご質問やお問い合わせは、以下のフォームよりお気軽にご連絡ください。</p>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 mb-16">
                    <div>
                        <h2 className="text-2xl text-black mb-6 tracking-tight" style={{ fontFamily: 'Didot, serif' }}>Get in Touch</h2>
                        <div className="space-y-6">
                            <div>
                                <h3 className="text-sm tracking-widest mb-2" style={{ fontFamily: 'acumin-pro, sans-serif' }}>EMAIL</h3>
                                <a href="mailto:info@lefildesheures.com" className="text-base text-[#474747] hover:text-black transition-colors duration-300" style={{ fontFamily: 'acumin-pro, sans-serif' }}>info@lefildesheures.com</a>
                            </div>
                            <div>
                                <h3 className="text-sm tracking-widest mb-2" style={{ fontFamily: 'acumin-pro, sans-serif' }}>PHONE</h3>
                                <p className="text-base text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>03-1234-5678</p>
                            </div>
                            <div>
                                <h3 className="text-sm tracking-widest mb-2" style={{ fontFamily: 'acumin-pro, sans-serif' }}>ADDRESS</h3>
                                <p className="text-base text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>東京都港区南青山3-14-15</p>
                            </div>
                            <div>
                                <h3 className="text-sm tracking-widest mb-2" style={{ fontFamily: 'acumin-pro, sans-serif' }}>BUSINESS HOURS</h3>
                                <p className="text-base text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>月〜金: 10:00 - 18:00<br />土日祝: 定休日</p>
                            </div>
                        </div>
                    </div>

                    <div>
                        <form className="space-y-6">
                            <div>
                                <label htmlFor="name" className="block text-sm tracking-widest mb-2" style={{ fontFamily: 'acumin-pro, sans-serif' }}>NAME *</label>
                                <input id="name" required className="w-full px-4 py-3 border border-black/20 focus:border-black outline-none transition-colors duration-300 text-sm" type="text" name="name" style={{ fontFamily: 'acumin-pro, sans-serif' }} />
                            </div>

                            <div>
                                <label htmlFor="email" className="block text-sm tracking-widest mb-2" style={{ fontFamily: 'acumin-pro, sans-serif' }}>EMAIL *</label>
                                <input id="email" required className="w-full px-4 py-3 border border-black/20 focus:border-black outline-none transition-colors duration-300 text-sm" type="email" name="email" style={{ fontFamily: 'acumin-pro, sans-serif' }} />
                            </div>

                            <div>
                                <label htmlFor="subject" className="block text-sm tracking-widest mb-2" style={{ fontFamily: 'acumin-pro, sans-serif' }}>SUBJECT *</label>
                                <input id="subject" required className="w-full px-4 py-3 border border-black/20 focus:border-black outline-none transition-colors duration-300 text-sm" type="text" name="subject" style={{ fontFamily: 'acumin-pro, sans-serif' }} />
                            </div>

                            <div>
                                <label htmlFor="message" className="block text-sm tracking-widest mb-2" style={{ fontFamily: 'acumin-pro, sans-serif' }}>MESSAGE *</label>
                                <textarea id="message" name="message" required rows={6} maxLength={500} className="w-full px-4 py-3 border border-black/20 focus:border-black outline-none transition-colors duration-300 resize-none text-sm" style={{ fontFamily: 'acumin-pro, sans-serif' }}></textarea>
                            </div>

                            <button type="submit" className="w-full py-4 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap" style={{ fontFamily: 'acumin-pro, sans-serif' }}>SEND MESSAGE</button>
                        </form>
                    </div>
                </div>
            </div>
        </main>
    );
}