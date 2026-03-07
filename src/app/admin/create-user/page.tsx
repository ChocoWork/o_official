"use client";

import React, { useState } from 'react';
import { Button } from '@/app/components/ui/Button';
import { TextField } from '@/app/components/ui/TextField';

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
        <TextField label="NAME" value={displayName} onChange={(e) => setDisplayName(e.target.value)}  size="md"/>
        <TextField label="EMAIL" value={email} onChange={(e) => setEmail(e.target.value)} type="email"  size="md"/>
        <TextField label="PASSWORD" value={password} onChange={(e) => setPassword(e.target.value)} type="password"  size="md"/>
        <div>
          <Button type="submit" disabled={loading} size="md">作成</Button>
        </div>
        {message ? <p className="text-sm mt-2">{message}</p> : null}
      </form>
    </div>
  );
}
