"use client";
import React from "react";
import LoginModal from "../components/LoginModal";

export default function LoginPage() {
  return (
    <main className="flex-1 flex items-center justify-center bg-white min-h-0 py-12">
      <LoginModal open={true} onClose={() => {}} />
    </main>
  );
}
