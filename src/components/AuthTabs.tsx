/**
 * ログインと会員登録を1つの画面で切り替えるタブ（src/components/AuthTabs.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-141
 * @design DD-AUTH-010
 * @remarks ログインと会員登録を別ページにすると導線が分かれるため、タブで切り替える（ADR-0410）。
 * 切り替えても URL は `/login` のままにする（FREQ-63-REQ-01）ので、履歴を積まず置き換える。
 * 左右の矢印で隣のタブへ移れる tablist にして、キーボードだけでも操作できるようにする。
 */
"use client";

import React, { useRef, useState } from "react";
import LoginModal from "@/components/LoginModal";
import RegisterModal from "@/components/RegisterModal";

export type AuthTab = "login" | "register";

const TABS: Array<{ key: AuthTab; label: string; path: string }> = [
  { key: "login", label: "ログイン", path: "/login" },
  { key: "register", label: "会員登録", path: "/login" },
];

interface AuthTabsProps {
  initialTab: AuthTab;
  initialEmail?: string;
  /** ログインの後の戻り先（サーバーが確かめた道筋）。タブを替えても保つ */
  returnTo?: string;
}

const AuthTabs: React.FC<AuthTabsProps> = ({ initialTab, initialEmail, returnTo }) => {
  const [activeTab, setActiveTab] = useState<AuthTab>(initialTab);
  const tabRefs = useRef<Partial<Record<AuthTab, HTMLButtonElement | null>>>(
    {},
  );

  const switchTab = (tab: AuthTab) => {
    if (tab === activeTab) return;
    setActiveTab(tab);
    const path = TABS.find((t) => t.key === tab)?.path;
    if (path) {
      window.history.replaceState(null, "", path);
    }
  };

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next: AuthTab = activeTab === "login" ? "register" : "login";
    switchTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="w-full max-w-md mx-auto">
      <div
        role="tablist"
        aria-label="ログイン / 会員登録"
        className="grid min-h-[55px] grid-cols-2 px-6"
      >
        {TABS.map(({ key, label }) => {
          const selected = key === activeTab;
          return (
            <button
              key={key}
              ref={(el) => {
                tabRefs.current[key] = el;
              }}
              type="button"
              role="tab"
              id={`auth-tab-${key}`}
              aria-selected={selected}
              aria-controls="auth-panel"
              tabIndex={selected ? 0 : -1}
              onClick={() => switchTab(key)}
              onKeyDown={handleTabKeyDown}
              className={`min-h-[55px] px-[21px] lk-text-lg tracking-widest transition-[color,border-color] duration-200 focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-black ${
                selected
                  ? "border-b-2 border-black text-black"
                  : "border-b border-black/20 text-[#737373] hover:border-black/40 hover:text-[#474747]"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id="auth-panel"
        aria-labelledby={`auth-tab-${activeTab}`}
        className="pt-[21px] sm:pt-[34px]"
      >
        {activeTab === "login" ? (
          <>
            <LoginModal open={true} returnTo={returnTo} />
          </>
        ) : (
          <>
            <RegisterModal
              onSwitchToLogin={() => switchTab("login")}
              initialEmail={initialEmail}
              returnTo={returnTo}
            />
          </>
        )}
      </div>
    </div>
  );
};

export default AuthTabs;
