"use client";

import Link from 'next/link';
import React, { useState } from "react";
import { usePathname } from 'next/navigation';
import LoginModal from "./LoginModal";
import { useLogin } from "./LoginContext";
import { useCart } from "./CartContext";
import { Button } from '@/app/components/ui/Button';
// Dropdown no longer needed for account menu

import "remixicon/fonts/remixicon.css";

const menuItems = [
  { href: '/news', label: 'NEWS' },
  { href: '/item', label: 'ITEM' },
  { href: '/look', label: 'LOOK' },
  { href: '/about', label: 'ABOUT' },
  { href: '/stockist', label: 'STOCKIST' },
  { href: '/ui', label: 'UI' },
];

const Header = () => {
  const [loginOpen, setLoginOpen] = useState(false);
  const pathname = usePathname();
  const { isLoggedIn, userRole } = useLogin();
  const canManage = userRole === 'admin' || userRole === 'supporter';
  const { cartCount } = useCart();

  const isActiveMenuItem = (href: string) => {
    if (href === '/') return pathname === '/';
    return pathname === href || pathname.startsWith(`${href}/`);
  };


  return (
    <header className="fixed top-0 left-0 right-0 bg-white z-50 border-b border-black/10">
      <div className="px-6 lg:px-12 py-6">
        <div className="flex items-center justify-between">
          {/* サイトタイトル */}
          <Link href="/">
            <h1 className="text-2xl text-black tracking-tight cursor-pointer hover:text-[#474747] transition-colors duration-300 font-display">
              Le Fil des Heures
            </h1>
          </Link>
          {/* メニュー（大画面のみ） */}
          <nav className="hidden lg:flex items-center gap-12 font-brand">
            {menuItems.map((item) => (
              <Link key={item.href} href={item.href} className="text-sm tracking-widest relative group cursor-pointer text-[#474747]">
                {item.label}
                <span
                  className={`absolute bottom-0 left-0 w-full h-[1px] bg-black transition-transform duration-300 origin-left ${
                    isActiveMenuItem(item.href) ? 'scale-x-100' : 'scale-x-0 group-hover:scale-x-100'
                  }`}
                ></span>
              </Link>
            ))}
            {canManage && (
              <Link href="/admin" className="text-sm tracking-widest relative group cursor-pointer text-[#474747]">
                MANAGE
                <span
                  className={`absolute bottom-0 left-0 w-full h-[1px] bg-black transition-transform duration-300 origin-left ${
                    isActiveMenuItem('/admin') ? 'scale-x-100' : 'scale-x-0 group-hover:scale-x-100'
                  }`}
                ></span>
              </Link>
            )}
          </nav>
          {/* 右側アイコン群 */}
          <div className="flex items-center gap-6">
            <Link href="/search" className="w-5 h-5 flex items-center justify-center cursor-pointer">
              <i className="ri-search-line text-xl text-black hover:text-[#474747] transition-colors"></i>
            </Link>
            <Link href="/wishlist" className="w-5 h-5 flex items-center justify-center cursor-pointer">
              <i className="ri-heart-line text-xl text-black hover:text-[#474747] transition-colors"></i>
            </Link>
            <Link href="/cart" className="w-5 h-5 flex items-center justify-center cursor-pointer relative">
              <i className="ri-shopping-bag-line text-xl text-black hover:text-[#474747] transition-colors"></i>
              {cartCount > 0 && (
                <span className="absolute -top-2 -right-2 w-5 h-5 bg-black text-white rounded-full flex items-center justify-center text-xs font-brand">
                  {cartCount}
                </span>
              )}
            </Link>
            <div className="relative">
              {isLoggedIn ? (
                <Link href="/account" className="w-5 h-5 flex items-center justify-center cursor-pointer">
                  <i className="ri-user-fill text-xl text-black hover:text-[#474747] transition-colors"></i>
                </Link>
              ) : (
                <Link href="/login" className="w-5 h-5 flex items-center justify-center cursor-pointer">
                  <i className="ri-user-line text-xl text-black hover:text-[#474747] transition-colors"></i>
                </Link>
              )}
            </div>
            <Button variant="ghost" size="sm" className="lg:hidden w-5 h-5 flex items-center justify-center cursor-pointer px-0 py-0">
              <i className="ri-menu-line text-2xl text-black"></i>
            </Button>
          </div>
        </div>
      </div>
      <LoginModal open={loginOpen && !isLoggedIn} onClose={() => setLoginOpen(false)} />
    </header>
  );
};

export default Header;