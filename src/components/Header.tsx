"use client";

import Link from 'next/link';
import React, { useState } from "react";
import { usePathname } from 'next/navigation';
import { Accordion } from '@/components/ui/Accordion/Accordion';
import LoginModal from "@/components/LoginModal";
import { useLogin } from "@/contexts/LoginContext";
import { useCart } from "@/contexts/CartContext";
import { Button } from '@/components/ui/Button/Button';
import { Drawer } from '@/components/ui/Drawer/Drawer';
import { LOOK_SEASON_OPTIONS } from '@/lib/look/public';
import { categories as newsCategories } from '@/lib/news-data';

const menuItems = [
  { href: '/news', label: 'NEWS' },
  { href: '/item', label: 'ITEM' },
  { href: '/look', label: 'LOOK' },
  { href: '/about', label: 'ABOUT' },
  { href: '/contact', label: 'CONTACT' },
  { href: '/stockist', label: 'STOCKIST' },
  { href: '/ui', label: 'UI' },
];

const HEADER_ITEM_CATEGORIES = ['ALL', 'TOPS', 'BOTTOMS', 'OUTERWEAR', 'ACCESSORIES'] as const;

const drawerFilterSections = [
  {
    key: 'news',
    label: 'NEWS',
    basePath: '/news',
    queryKey: 'category',
    values: newsCategories,
  },
  {
    key: 'item',
    label: 'ITEM',
    basePath: '/item',
    queryKey: 'category',
    values: HEADER_ITEM_CATEGORIES,
  },
  {
    key: 'look',
    label: 'LOOK',
    basePath: '/look',
    queryKey: 'season',
    values: LOOK_SEASON_OPTIONS,
  },
] as const;

function buildDrawerFilterHref(basePath: string, queryKey: string, value: string) {
  if (value === 'ALL') {
    return basePath;
  }

  return `${basePath}?${queryKey}=${encodeURIComponent(value)}`;
}

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

  const activeDrawerSectionKey = React.useMemo(() => {
    if (pathname.startsWith('/news')) {
      return 'news';
    }
    if (pathname.startsWith('/item')) {
      return 'item';
    }
    if (pathname.startsWith('/look')) {
      return 'look';
    }
    return null;
  }, [pathname]);

  const drawerStaticItems = React.useMemo(
    () => menuItems.filter((item) => !['/news', '/item', '/look'].includes(item.href)),
    [],
  );

  const drawerAccordionItems = drawerFilterSections.map((section) => ({
    key: section.key,
    title: section.label,
    content: (
      <div className="header-drawer-accordion-links">
        {section.values.map((value) => {
          const href = buildDrawerFilterHref(section.basePath, section.queryKey, value);

          return (
            <Link
              key={value}
              href={href}
              onClick={() => setDrawerOpen(false)}
              className="font-brand block py-[2px] text-[12px] leading-[1.45] tracking-[0.16em] text-[#474747] uppercase no-underline transition-colors"
            >
              {value}
            </Link>
          );
        })}
      </div>
    ),
  }));


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
            className="header-menu-button icon-frame p-0"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
          >
            <i className="ri-menu-line icon"></i>
          </Button>
        </div>
      </div>
    </header>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} size="md">
        <div className="pb-6 sm:pb-8 md:pb-10">
          <div
            className="flex items-center justify-end px-[13px] sm:px-[16px] md:px-[21px]"
            style={{ height: 'var(--site-header-height)' }}
          >
            <Button
              variant="ghost"
              size="sm"
              className="header-drawer-close-button icon-frame p-0"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close drawer"
            >
              <i className="ri-close-line icon"></i>
            </Button>
          </div>
          <div className="px-[25px]">
            <nav className="flex flex-col gap-[10px]" aria-label="Mobile navigation">
              <Accordion
                items={drawerAccordionItems}
                size="sm"
                openMode="single"
                defaultOpenKeys={activeDrawerSectionKey ? [activeDrawerSectionKey] : []}
                className="w-full max-w-none overflow-visible border-0 bg-transparent [--accordion-font-size:0.75rem] [--accordion-pad-block:0.625rem] [--accordion-pad-inline:0] [--accordion-min-height:auto] [--accordion-item-gap:0] [--accordion-icon-box-size:1rem] [--accordion-border-color:rgb(17_17_17_/_0.08)] [--accordion-surface-hover:transparent] [--accordion-surface-active:transparent] [--accordion-title-color:#111111] [--accordion-content-color:#111111]"
                triggerClassName="font-brand w-full border-b border-black/8 bg-transparent px-0 py-[10px] text-left text-[12px] leading-[1.4] tracking-[0.18em] uppercase hover:bg-transparent"
                contentClassName="px-0 pt-[6px] pb-[12px]"
              />
              <div className="flex flex-col">
                {drawerStaticItems.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setDrawerOpen(false)}
                    aria-current={isActiveMenuItem(item.href) ? 'page' : undefined}
                    data-active={isActiveMenuItem(item.href) ? 'true' : undefined}
                    className="font-brand block border-b border-black/8 py-[10px] text-[12px] leading-[1.4] tracking-[0.18em] text-black uppercase no-underline transition-colors"
                  >
                    {item.label}
                  </Link>
                ))}
                {canManage ? (
                  <Link
                    href="/admin"
                    onClick={() => setDrawerOpen(false)}
                    aria-current={isActiveMenuItem('/admin') ? 'page' : undefined}
                    data-active={isActiveMenuItem('/admin') ? 'true' : undefined}
                    className="font-brand block border-b border-black/8 py-[10px] text-[12px] leading-[1.4] tracking-[0.18em] text-black uppercase no-underline transition-colors"
                  >
                    MANAGE
                  </Link>
                ) : null}
              </div>
            </nav>
            <div className="mt-8 border-t border-black/10 pt-6">
              <p
                className="mb-4 text-xs tracking-widest text-black/60"
                style={{ fontFamily: 'acumin-pro, sans-serif' }}
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
        </div>
      </Drawer>

      <LoginModal open={loginOpen && !isLoggedIn} onClose={() => setLoginOpen(false)} />
    </>
  );
};

export default Header;