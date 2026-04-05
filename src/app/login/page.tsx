"use client";
import React from "react";
import LoginModal from "@/components/LoginModal";

export default function LoginPage() {
  return (
    <div className="pb-10 sm:pb-14 px-6 lg:px-12">
      <LoginModal open={true} onClose={() => {}} />
    </div>
  );
}
