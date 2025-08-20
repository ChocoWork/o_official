'use client';

import React, { createContext, useContext, useState, ReactNode } from "react";

interface LoginContextType {
  isLoggedIn: boolean;
  isAdmin: boolean;
  login: (email?: string, password?: string) => void;
  logout: () => void;
}

const LoginContext = createContext<LoginContextType | undefined>(undefined);

export const useLogin = () => {
  const context = useContext(LoginContext);
  if (!context) throw new Error("useLogin must be used within a LoginProvider");
  return context;
};

export const LoginProvider = ({ children }: { children: ReactNode }) => {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  const login = (email?: string, password?: string) => {
    console.log("login called with:", { email, password });
    setIsLoggedIn(true);
    if (email === 'aaa@gmail.com' && password === 'bbb') {
      setIsAdmin(true);
    } else {
      setIsAdmin(false);
    }
    // 認証状態をデバッグ出力
    setTimeout(() => {
      console.log("After login:", { isLoggedIn: true, isAdmin: email === 'aaa@gmail.com' && password === 'bbb', email, password });
    }, 0);
  };

  const logout = () => {
    setIsLoggedIn(false);
    setIsAdmin(false);
    // 認証状態をデバッグ出力
    setTimeout(() => {
      console.log("After logout:", { isLoggedIn: false, isAdmin: false });
    }, 0);
  };

  // 状態が変わるたびに認証状態を出力
  React.useEffect(() => {
    console.log("Auth state changed:", { isLoggedIn, isAdmin });
  }, [isLoggedIn, isAdmin]);

  return (
    <LoginContext.Provider value={{ isLoggedIn, isAdmin, login, logout }}>
      {children}
    </LoginContext.Provider>
  );
};
