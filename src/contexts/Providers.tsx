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
  const isAdmin = pathname.startsWith('/admin');

  return (
    <CartProvider>
      <LoginProvider>
        <Header />
        {isAdmin ? (
          <div className="flex-1 flex flex-col">{children}</div>
        ) : (
          <main className={`flex-1 flex flex-col${isHome ? '' : ' pt-16 sm:pt-20 md:pt-24 lg:pt-28'}`}>
            {children}
          </main>
        )}
        <Footer />
      </LoginProvider>
    </CartProvider>
  );
}
