"use client";

import Link from 'next/link';
import React, { useState } from "react";
import { usePathname } from 'next/navigation';
import LoginModal from "./LoginModal";
import { useLogin } from "./LoginContext";
import "remixicon/fonts/remixicon.css";

const menuItems = [
  { href: '/news', label: 'NEWS' },
  { href: '/item', label: 'ITEM' },
  { href: '/look', label: 'LOOK' },
  { href: '/about', label: 'ABOUT' },
  { href: '/stockist', label: 'STOCKIST' },
];

const Header = () => {
  const [loginOpen, setLoginOpen] = useState(false);
  const { isLoggedIn, isAdmin, logout } = useLogin();
  const pathname = usePathname();

  return (
    <header className="fixed top-0 left-0 right-0 bg-white z-50 border-b border-black/10">
      <div className="px-6 lg:px-12 py-6">
        <div className="flex items-center justify-between">
          {/* サイトタイトル */}
          <Link href="/">
            <h1 className="text-2xl text-black tracking-tight cursor-pointer hover:text-[#474747] transition-colors duration-300" style={{ fontFamily: 'Didot, serif' }}>
              Le Fil des Heures
            </h1>
          </Link>
          {/* メニュー（大画面のみ） */}
          <nav className="hidden lg:flex items-center gap-12">
            {menuItems.map((item) => (
              <Link key={item.href} href={item.href} className="text-sm tracking-widest relative group cursor-pointer text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                {item.label}
                <span className="absolute bottom-0 left-0 w-full h-[1px] bg-black transition-transform duration-300 scale-x-0 group-hover:scale-x-100" style={{ transformOrigin: 'left' }}></span>
              </Link>
            ))}
            {isAdmin && (
              <Link href="/admin" className="text-sm tracking-widest relative group cursor-pointer text-red-700" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                Admin
                <span className="absolute bottom-0 left-0 w-full h-[1px] bg-red-700 transition-transform duration-300 scale-x-0 group-hover:scale-x-100" style={{ transformOrigin: 'left' }}></span>
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
              <span className="absolute -top-2 -right-2 w-5 h-5 bg-black text-white rounded-full flex items-center justify-center text-xs" style={{ fontFamily: 'acumin-pro, sans-serif' }}>3</span>
            </Link>
            <div className="relative">
              <Link href="/login" className="w-5 h-5 flex items-center justify-center cursor-pointer">
                <i className="ri-user-line text-xl text-black hover:text-[#474747] transition-colors"></i>
              </Link>
            </div>
            <button className="lg:hidden w-5 h-5 flex items-center justify-center cursor-pointer">
              <i className="ri-menu-line text-2xl text-black"></i>
            </button>
          </div>
        </div>
      </div>
      <LoginModal open={loginOpen && !isLoggedIn} onClose={() => setLoginOpen(false)} />
    </header>
  );
};

export default Header;