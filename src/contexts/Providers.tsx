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

  const pageMainClassName = isHome
    ? 'flex-1 flex flex-col'
    : 'flex-1 flex flex-col my-[52px] sm:my-[54px] md:my-[56px] lg:my-[58px] xl:my-[60px] pt-0 sm:pt-1 md:pt-2 lg:pt-4 px-6 lg:px-12';

  return (
    <CartProvider enabled={!isPrivacyPage}>
      <LoginProvider>
        <Header />
        <main className={pageMainClassName}>
          {children}
        </main>
        <Footer />
      </LoginProvider>
    </CartProvider>
  );
}
