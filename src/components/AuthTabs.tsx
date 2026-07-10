"use client";

import React, { useRef, useState } from "react";
import LoginModal from "@/components/LoginModal";
import RegisterModal from "@/components/RegisterModal";

export type AuthTab = "login" | "register";

const mdTextStyle: React.CSSProperties = { fontSize: "var(--lk-size-md)" };

const TABS: Array<{ key: AuthTab; label: string; path: string }> = [
  { key: "login", label: "ログイン", path: "/login" },
  { key: "register", label: "会員登録", path: "/login" },
];

interface AuthTabsProps {
  initialTab: AuthTab;
}

const AuthTabs: React.FC<AuthTabsProps> = ({ initialTab }) => {
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
    <div className="w-full max-w-md mx-auto px-4 sm:px-6 pt-2">
      <div
        role="tablist"
        aria-label="ログイン / 会員登録"
        className="grid grid-cols-2 px-6"
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
              className={`min-h-[48px] px-4 tracking-widest border-b transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-black ${
                selected
                  ? "border-black text-black"
                  : "border-black/20 text-[#a3a3a3] hover:text-[#595959]"
              }`}
              style={mdTextStyle}
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
        className="pt-6 sm:pt-10 lg:pt-[55px]"
      >
        {activeTab === "login" ? (
          <>
            <LoginModal open={true} />
          </>
        ) : (
          <>
            <RegisterModal onSwitchToLogin={() => switchTab("login")} />
          </>
        )}
      </div>
    </div>
  );
};

export default AuthTabs;
