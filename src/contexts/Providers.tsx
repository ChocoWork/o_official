'use client';

import React from 'react';
import { CartProvider } from '@/contexts/CartContext';
import { LoginProvider } from '@/contexts/LoginContext';
import Header from '@/components/Header';
import Footer from '@/components/Footer';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <CartProvider>
      <LoginProvider>
        <Header />
        <div className="flex-1 flex flex-col">
          {children}
        </div>
        <Footer />
      </LoginProvider>
    </CartProvider>
  );
}
