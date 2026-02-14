"use client";

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function VerifiedPage() {
  const [message, setMessage] = useState<string | null>('確認完了。アカウントへ移動します…');
  const router = useRouter();

  useEffect(() => {
    const timer = setTimeout(() => router.push('/account'), 800);
    return () => clearTimeout(timer);
  }, [router]);

  return (
    <div className="max-w-xl mx-auto p-6">
      <h1 className="text-xl mb-4">メール確認</h1>
      <p className="mb-4">{message}</p>
      <div>
        <a href="/account" className="text-blue-600">アカウントへ</a>
        <span className="mx-2 text-gray-400">/</span>
        <a href="/login" className="text-blue-600">ログインページへ</a>
      </div>
    </div>
  );
}
