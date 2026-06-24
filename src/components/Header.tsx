"use client";

import Link from "next/link";
import React, { useState } from "react";
import { usePathname } from "next/navigation";
import { Accordion } from "@/components/ui/Accordion/Accordion";
import LoginModal from "@/components/LoginModal";
import { useLogin } from "@/contexts/LoginContext";
import { useCart } from "@/contexts/CartContext";
import { Button } from "@/components/ui/Button/Button";
import { Drawer } from "@/components/ui/Drawer/Drawer";
import { LOOK_SEASON_OPTIONS } from "@/lib/look/public";
import { categories as newsCategories } from "@/lib/news-data";
import { VISIBLE_SOCIAL_LINKS } from "@/lib/social";

const menuItems = [
  { href: "/news", label: "NEWS" },
  { href: "/item", label: "ITEM" },
  { href: "/look", label: "LOOK" },
  { href: "/stockist", label: "STOCKIST" },
  { href: "/about", label: "ABOUT" },
  { href: "/contact", label: "CONTACT" },
  { href: "/ui", label: "UI" },
];

const HEADER_ITEM_CATEGORIES = [
  "ALL",
  "TOPS",
  "BOTTOMS",
  "OUTERWEAR",
  "ACCESSORIES",
] as const;

const drawerFilterSections = [
  {
    key: "news",
    label: "NEWS",
    basePath: "/news",
    queryKey: "category",
    values: newsCategories,
  },
  {
    key: "item",
    label: "ITEM",
    basePath: "/item",
    queryKey: "category",
    values: HEADER_ITEM_CATEGORIES,
  },
  {
    key: "look",
    label: "LOOK",
    basePath: "/look",
    queryKey: "season",
    values: LOOK_SEASON_OPTIONS,
  },
] as const;

function buildDrawerFilterHref(
  basePath: string,
  queryKey: string,
  value: string,
) {
  if (value === "ALL") {
    return basePath;
  }

  return `${basePath}?${queryKey}=${encodeURIComponent(value)}`;
}

const Header = () => {
  const [loginOpen, setLoginOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isHidden, setIsHidden] = useState(false);
  const pathname = usePathname();
  const { isLoggedIn, userRole } = useLogin();
  const canManage = userRole === "admin" || userRole === "supporter";
  const { cartCount } = useCart();

  const lastScrollY = React.useRef(0);

  React.useEffect(() => {
    const syncHeaderVisibility = () => {
      const currentScrollY = window.scrollY;

      if (currentScrollY <= 0) {
        setIsHidden(false);
      } else if (currentScrollY > lastScrollY.current && currentScrollY > 50) {
        setIsHidden(true);
      } else if (currentScrollY < lastScrollY.current) {
        setIsHidden(false);
      }

      lastScrollY.current = currentScrollY;
    };

    syncHeaderVisibility();
    window.addEventListener("scroll", syncHeaderVisibility, { passive: true });
    return () => window.removeEventListener("scroll", syncHeaderVisibility);
  }, []);

  const isActiveMenuItem = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  const activeDrawerSectionKey = React.useMemo(() => {
    if (pathname.startsWith("/news")) {
      return "news";
    }
    if (pathname.startsWith("/item")) {
      return "item";
    }
    if (pathname.startsWith("/look")) {
      return "look";
    }
    return null;
  }, [pathname]);

  const drawerStaticItems = React.useMemo(
    () =>
      menuItems.filter(
        (item) => !["/news", "/item", "/look"].includes(item.href),
      ),
    [],
  );

  const drawerAccordionItems = drawerFilterSections.map((section) => ({
    key: section.key,
    title: (
      <span className="header-drawer-accordion-title">{section.label}</span>
    ),
    content: (
      <div className="header-drawer-accordion-links">
        {section.values.map((value) => {
          const href = buildDrawerFilterHref(
            section.basePath,
            section.queryKey,
            value,
          );

          return (
            <Link
              key={value}
              href={href}
              onClick={() => setDrawerOpen(false)}
              className="header-drawer-subnav-link"
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
      <header
        className={`fixed top-0 left-0 right-0 bg-white z-50 h-[52px] sm:h-[54px] md:h-[56px] xl:h-[60px] transition-transform duration-300 ease-in-out ${isHidden ? "-translate-y-full" : "translate-y-0"}`}
      >
        <div className="header-position">
          {/* サイトタイトル */}
          <Link href="/" aria-label="Le Fil des Heures home">
            <span className="header-title font-display">Le Fil des Heures</span>
          </Link>
          {/* ナビゲーション（大画面のみ） */}
          <nav className="header-nav-position">
            {menuItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="header-nav-title group"
              >
                {item.label}
                <span
                  className={`underline-animation-left2right ${
                    isActiveMenuItem(item.href)
                      ? "scale-x-100"
                      : "scale-x-0 group-hover:scale-x-100"
                  }`}
                ></span>
              </Link>
            ))}
            {canManage && (
              <Link href="/admin" className="header-nav-title group">
                MANAGE
                <span
                  className={`underline-animation-left2right ${
                    isActiveMenuItem("/admin")
                      ? "scale-x-100"
                      : "scale-x-0 group-hover:scale-x-100"
                  }`}
                ></span>
              </Link>
            )}
          </nav>
          {/* 右側アイコン群 */}
          <div className="header-nav-icon-position">
            <Link
              href="/search"
              aria-label="検索"
              className="icon-frame min-h-[44px]"
            >
              <i className="ri-search-line icon"></i>
            </Link>
            <Link
              href="/wishlist"
              aria-label="ウィッシュリスト"
              className="icon-frame min-h-[44px]"
            >
              <i className="ri-heart-line icon"></i>
            </Link>
            <Link
              href="/cart"
              aria-label={cartCount > 0 ? `カート（${cartCount}点）` : "カート"}
              className="icon-frame min-h-[44px]"
            >
              <span className="relative inline-flex">
                <i className="ri-shopping-bag-line icon"></i>
                {cartCount > 0 && (
                  <span className="absolute top-0 right-0 translate-x-1/2 -translate-y-1/2 min-w-[16px] h-[16px] bg-black text-white rounded-full flex items-center justify-center text-[10px] font-medium leading-[0] tabular-nums">
                    {cartCount}
                  </span>
                )}
              </span>
            </Link>
            <div className="relative">
              {isLoggedIn ? (
                <Link
                  href="/account"
                  aria-label="アカウント"
                  className="icon-frame min-h-[44px]"
                >
                  <i className="ri-user-fill icon"></i>
                </Link>
              ) : (
                <Link
                  href="/login"
                  aria-label="ログイン"
                  className="icon-frame min-h-[44px]"
                >
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

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        size="md"
        className="!border-l-0"
      >
        <div className="header-drawer-shell">
          <div className="header-drawer-top-row">
            <Button
              variant="ghost"
              size="sm"
              shape="pill"
              className="header-drawer-close-button icon-frame p-0"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close drawer"
            >
              <i className="ri-close-line icon"></i>
            </Button>
          </div>
          <div className="header-drawer-content">
            <nav className="header-drawer-nav" aria-label="Mobile navigation">
              <Accordion
                items={drawerAccordionItems}
                size="sm"
                openMode="single"
                defaultOpenKeys={
                  activeDrawerSectionKey ? [activeDrawerSectionKey] : []
                }
                highlightOnHover={false}
                showUnderline={false}
                showTopline={true}
                className="header-drawer-accordion !border-0 !bg-transparent"
              />
              <div className="header-drawer-links">
                {drawerStaticItems.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setDrawerOpen(false)}
                    aria-current={
                      isActiveMenuItem(item.href) ? "page" : undefined
                    }
                    data-active={
                      isActiveMenuItem(item.href) ? "true" : undefined
                    }
                    className="header-drawer-primary-link"
                  >
                    {item.label}
                  </Link>
                ))}
                {canManage ? (
                  <Link
                    href="/admin"
                    onClick={() => setDrawerOpen(false)}
                    aria-current={
                      isActiveMenuItem("/admin") ? "page" : undefined
                    }
                    data-active={
                      isActiveMenuItem("/admin") ? "true" : undefined
                    }
                    className="header-drawer-primary-link"
                  >
                    MANAGE
                  </Link>
                ) : null}
              </div>
            </nav>
            <div className="header-drawer-follow">
              <p className="header-drawer-follow-title">FOLLOW US</p>
              <div className="flex items-center gap-4">
                {VISIBLE_SOCIAL_LINKS.map((social) => (
                  <a
                    key={social.key}
                    href={social.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={social.label}
                    onClick={() => setDrawerOpen(false)}
                    className="w-10 h-10 flex items-center justify-center border border-black text-black hover:bg-black hover:text-white transition-all duration-200"
                  >
                    <i
                      className={`${social.iconClass} header-drawer-follow-icon`}
                      aria-hidden="true"
                    ></i>
                  </a>
                ))}
              </div>
            </div>
          </div>
        </div>
      </Drawer>

      <LoginModal
        open={loginOpen && !isLoggedIn}
        onClose={() => setLoginOpen(false)}
      />
    </>
  );
};

export default Header;
