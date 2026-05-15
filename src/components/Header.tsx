"use client";

import Link from 'next/link';
import React, { useState } from "react";
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import LoginModal from "@/components/LoginModal";
import { useLogin } from "@/contexts/LoginContext";
import { useCart } from "@/contexts/CartContext";
import { Button } from '@/components/ui/Button/Button';
import { Drawer } from '@/components/ui/Drawer/Drawer';

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
    const syncHeaderVisibility = () => {
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

    syncHeaderVisibility();
    window.addEventListener('scroll', syncHeaderVisibility, { passive: true });
    return () => window.removeEventListener('scroll', syncHeaderVisibility);
  }, []);

  React.useLayoutEffect(() => {
    document.documentElement.dataset.headerVisible = isHeaderVisible ? 'true' : 'false';
  }, [isHeaderVisible]);

  const isActiveMenuItem = (href: string) => {
    if (href === '/') return pathname === '/';
    return pathname === href || pathname.startsWith(`${href}/`);
  };


  return (
    <>
    <header className={`fixed top-0 left-0 right-0 bg-white z-50 h-[52px] sm:h-[54px] md:h-[56px] xl:h-[60px] transition-transform duration-300 ease-in-out ${isHeaderVisible ? 'translate-y-0' : '-translate-y-full'}`}>
      <div className="header-position">
        {/* サイトタイトル */}
        <Link href="/" aria-label="Le Fil des Heures home">
          <span className="header-title font-display">
            Le Fil des Heures
          </span>
        </Link>
        {/* ナビゲーション（大画面のみ） */}
        <nav className="header-nav-position">
          {menuItems.map((item) => (
            <Link key={item.href} href={item.href} className="header-nav-title group">
              {item.label}
              <span
                className={`underline-animation-left2right ${
                  isActiveMenuItem(item.href) ? 'scale-x-100' : 'scale-x-0 group-hover:scale-x-100'
                }`}
              ></span>
            </Link>
          ))}
          {canManage && (
            <Link href="/admin" className="header-nav-title group">
              MANAGE
              <span
                className={`underline-animation-left2right ${
                  isActiveMenuItem('/admin') ? 'scale-x-100' : 'scale-x-0 group-hover:scale-x-100'
                }`}
              ></span>
            </Link>
          )}
        </nav>
        {/* 右側アイコン群 */}
        <div className="header-nav-icon-position">
          <Link href="/search" aria-label="Search" className="icon-flame">
            <i className="ri-search-line icon"></i>
          </Link>
          <Link href="/wishlist" className="icon-flame">
            <i className="ri-heart-line icon"></i>
          </Link>
          <Link href="/cart" className="icon-flame relative">
            <i className="ri-shopping-bag-line icon"></i>
            {cartCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 w-4 h-4 sm:-top-2 sm:-right-2 sm:w-5 sm:h-5 bg-black text-white rounded-full flex items-center justify-center text-[9px] sm:text-xs">
                {cartCount}
              </span>
            )}
          </Link>
          <div className="relative">
            {isLoggedIn ? (
              <Link href="/account" className="icon-flame">
                <i className="ri-user-fill icon"></i>
              </Link>
            ) : (
              <Link href="/login" className="icon-flame">
                <i className="ri-user-line icon"></i>
              </Link>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="lg:hidden icon-frame p-0 hover:bg-transparent"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
          >
            <i className="ri-menu-line icon"></i>
          </Button>
        </div>
      </div>
    </header>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} size="md">
        <div className="p-6 sm:p-8">
          <div className="flex items-center justify-between mb-4">
            <h3
              className="text-xl sm:text-2xl text-black tracking-tight"
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