"use client";

import Link from 'next/link';
import React, { useState } from "react";
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import LoginModal from "@/components/LoginModal";
import { useLogin } from "@/contexts/LoginContext";
import { useCart } from "@/contexts/CartContext";
import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';

const menuItems = [
  { href: '/news', label: 'NEWS' },
  { href: '/item', label: 'ITEM' },
  { href: '/look', label: 'LOOK' },
  { href: '/about', label: 'ABOUT' },
  { href: '/contact', label: 'CONTACT' },
  { href: '/stockist', label: 'STOCKIST' },
  { href: '/ui', label: 'UI' },
];

const Header = () => {
  const [loginOpen, setLoginOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isHeaderVisible, setIsHeaderVisible] = useState(true);
  const pathname = usePathname();
  const { isLoggedIn, userRole } = useLogin();
  const canManage = userRole === 'admin' || userRole === 'supporter';
  const { cartCount } = useCart();

  const lastScrollY = React.useRef(0);

  React.useEffect(() => {
    const onScroll = () => {
      const currentScrollY = window.scrollY;

      if (currentScrollY <= 0) {
        setIsHeaderVisible(true);
      } else if (currentScrollY > lastScrollY.current && currentScrollY > 50) {
        setIsHeaderVisible(false);
      } else if (currentScrollY < lastScrollY.current) {
        setIsHeaderVisible(true);
      }

      lastScrollY.current = currentScrollY;
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const isActiveMenuItem = (href: string) => {
    if (href === '/') return pathname === '/';
    return pathname === href || pathname.startsWith(`${href}/`);
  };


  return (
    <>
    <header className={`fixed left-0 right-0 bg-white z-50 transition-transform duration-300 ease-in-out ${isHeaderVisible ? 'translate-y-0' : '-translate-y-full'}`}>
      <div className="px-4 sm:px-6 lg:px-12 py-3.5 sm:py-4 md:py-5 lg:py-6">
        <div className="flex items-center justify-between">
          {/* サイトタイトル */}
          <Link href="/">
            <h1 className="text-[15px] sm:text-xl md:text-2xl text-black tracking-tight cursor-pointer hover:text-[#474747] transition-colors duration-300 font-display whitespace-nowrap">
              Le Fil des Heures
            </h1>
          </Link>
          {/* メニュー（大画面のみ） */}
          <nav className="hidden lg:flex items-center gap-6 xl:gap-12 font-brand">
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
          <div className="flex items-center gap-2.5 sm:gap-4 md:gap-5 lg:gap-6">
            <Link href="/search" className="w-[18px] h-[18px] sm:w-5 sm:h-5 flex items-center justify-center cursor-pointer">
              <i className="ri-search-line text-[18px] sm:text-xl text-black hover:text-[#474747] transition-colors"></i>
            </Link>
            <Link href="/wishlist" className="w-[18px] h-[18px] sm:w-5 sm:h-5 flex items-center justify-center cursor-pointer">
              <i className="ri-heart-line text-[18px] sm:text-xl text-black hover:text-[#474747] transition-colors"></i>
            </Link>
            <Link href="/cart" className="w-[18px] h-[18px] sm:w-5 sm:h-5 flex items-center justify-center cursor-pointer relative">
              <i className="ri-shopping-bag-line text-[18px] sm:text-xl text-black hover:text-[#474747] transition-colors"></i>
              {cartCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 w-4 h-4 sm:-top-2 sm:-right-2 sm:w-5 sm:h-5 bg-black text-white rounded-full flex items-center justify-center text-[9px] sm:text-xs font-brand">
                  {cartCount}
                </span>
              )}
            </Link>
            <div className="relative">
              {isLoggedIn ? (
                <Link href="/account" className="w-[18px] h-[18px] sm:w-5 sm:h-5 flex items-center justify-center cursor-pointer">
                  <i className="ri-user-fill text-[18px] sm:text-xl text-black hover:text-[#474747] transition-colors"></i>
                </Link>
              ) : (
                <Link href="/login" className="w-[18px] h-[18px] sm:w-5 sm:h-5 flex items-center justify-center cursor-pointer">
                  <i className="ri-user-line text-[18px] sm:text-xl text-black hover:text-[#474747] transition-colors"></i>
                </Link>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="lg:hidden w-5 h-5 flex items-center justify-center cursor-pointer px-0 py-0 hover:bg-transparent"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
            >
              <i className="ri-menu-line text-[18px] sm:text-2xl text-black"></i>
            </Button>
          </div>
        </div>
      </div>

    </header>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} size="md">
        <div className="p-6 sm:p-8">
          <div className="flex items-center justify-between mb-4">
            <h3
              className="text-2xl text-black tracking-tight"
              style={{ fontFamily: "Didot, serif" }}
            >
              Menu
            </h3>
            <Button
              variant="ghost"
              size="md"
              className="aspect-square px-0 flex items-center justify-center hover:bg-[#f5f5f5] transition-colors cursor-pointer"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close drawer"
            >
              <div className="w-5 h-5 flex items-center justify-center">
                <i className="ri-close-line text-xl"></i>
              </div>
            </Button>
          </div>
          <nav className="space-y-0">
            {[...menuItems].map((item) => (
              <Button
                key={item.label}
                variant="ghost"
                size="md"
                href={item.href}
                onClick={() => setDrawerOpen(false)}
                className={cn('w-full justify-start text-left px-4 py-2.5 md:py-2 text-sm h-auto')}
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                {item.label}
              </Button>
            ))}
          </nav>
          <div className="mt-8 pt-6 border-t border-black/10">
            <p
              className="text-xs tracking-widest text-black/60 mb-4"
              style={{ fontFamily: "acumin-pro, sans-serif" }}
            >
              FOLLOW US
            </p>
            <div className="flex items-center gap-4">
              {['instagram','facebook','twitter'].map((icon) => (
                <Button
                  key={icon}
                  variant="secondary"
                  size="md"
                  className="aspect-square px-0"
                >
                  <div className="w-5 h-5 flex items-center justify-center">
                    <i className={`ri-${icon}-line text-xl`}></i>
                  </div>
                </Button>
              ))}
            </div>
          </div>
        </div>
      </Drawer>

      <LoginModal open={loginOpen && !isLoggedIn} onClose={() => setLoginOpen(false)} />
    </>
  );
};

export default Header;