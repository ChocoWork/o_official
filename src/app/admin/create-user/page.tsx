/**
 * 店長がその場で利用者のアカウントを作る画面（src/app/admin/create-user/page.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-ADMIN-101
 * @design DD-ADMIN-001
 * @remarks 入力欄と送信中の印を持つので利用者の端末で動かす。会員登録と同じ16文字の決まりを送る前に見せて、短い入力を早く直せるようにする（窓口の下限は8文字で、画面の方が厳しい）。画面は守りを持たず、作れるかは窓口の認可で決まる。CSRF の印は付けず、proxy の Origin の照合に任せる。
 */
"use client";

import React, { useState } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { TextField } from '@/components/ui/TextField/TextField';

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
    if (password.length < 16) {
      setMessage('パスワードは16文字以上にしてください');
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
      <h1 className="mb-4">管理者: ユーザ作成</h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        <TextField label="NAME" value={displayName} onChange={(e) => setDisplayName(e.target.value)}  size="md"/>
        <TextField label="EMAIL" value={email} onChange={(e) => setEmail(e.target.value)} type="email"  size="md"/>
        <TextField label="PASSWORD" value={password} onChange={(e) => setPassword(e.target.value)} type="password"  size="md"/>
        <div>
          <Button type="submit" disabled={loading} size="md">作成</Button>
        </div>
        {message ? <p className="lk-text-sm mt-2">{message}</p> : null}
      </form>
    </div>
  );
}
