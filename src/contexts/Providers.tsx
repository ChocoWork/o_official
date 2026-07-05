'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { CartProvider } from '@/contexts/CartContext';
import { LoginProvider } from '@/contexts/LoginContext';
import Header from '@/components/Header';
import Footer from '@/components/Footer';

export function Providers({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isHome = pathname === '/';
  const isPrivacyPage = pathname === '/privacy';
  const isAuthPage = pathname === '/login' || pathname === '/auth/password-reset';

  const pageMainClassName = isHome
    ? 'flex-1 flex flex-col'
    : isAuthPage
      ? 'flex items-center justify-center min-h-[calc(100dvh-56px)] mt-14 px-5 py-4'
      : 'flex-1 flex flex-col my-[52px] sm:my-[54px] md:my-[56px] lg:my-[58px] xl:my-[60px] py-0 sm:py-1 md:py-2 lg:py-3 px-5';

  return (
    <CartProvider enabled={!isPrivacyPage}>
      <LoginProvider>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:bg-white focus:text-black focus:px-4 focus:py-2 focus:text-sm focus:border focus:border-black"
        >
          メインコンテンツへスキップ
        </a>
        <Header />
        <main id="main-content" className={pageMainClassName}>
          {children}
        </main>
        <Footer />
      </LoginProvider>
    </CartProvider>
  );
}
