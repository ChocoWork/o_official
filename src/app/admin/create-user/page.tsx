"use client";

import React, { useState } from 'react';

export default function AdminCreateUserPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    if (!email || !password) {
      setMessage('メールとパスワードを入力してください');
      return;
    }
    if (password.length < 8) {
      setMessage('パスワードは8文字以上にしてください');
      return;
    }

    try {
      setLoading(true);
      const res = await fetch('/api/admin/create-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, display_name: displayName }),
      });

      const payload = await res.json().catch(() => null);
      if (res.status === 201) {
        setMessage('ユーザ作成しました: ' + (payload?.email || ''));
        setEmail('');
        setPassword('');
        setDisplayName('');
        return;
      }

      setMessage((payload && payload.error) || '作成に失敗しました');
    } catch (err) {
      console.error(err);
      setMessage('ネットワークエラーが発生しました');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-md mx-auto p-6">
      <h1 className="text-xl mb-4">管理者: ユーザ作成</h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm mb-1">NAME</label>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="w-full px-3 py-2 border" />
        </div>
        <div>
          <label className="block text-sm mb-1">EMAIL</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" className="w-full px-3 py-2 border" />
        </div>
        <div>
          <label className="block text-sm mb-1">PASSWORD</label>
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" className="w-full px-3 py-2 border" />
        </div>
        <div>
          <button type="submit" disabled={loading} className="px-4 py-2 bg-black text-white">作成</button>
        </div>
        {message ? <p className="text-sm mt-2">{message}</p> : null}
      </form>
    </div>
  );
}
