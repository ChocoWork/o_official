"use client";
import React from "react";
import LoginModal from "../components/LoginModal";

export default function LoginPage() {
  return (
    <main className="pt-32 pb-20 px-6 lg:px-12">
      <LoginModal open={true} onClose={() => {}} />
    </main>
  );
}
