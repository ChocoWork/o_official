// File: app/(app)/profile/page.tsx
//
// このサンプルは Skill 規約準拠の実装例です。
// - Server Component（デフォルト）
// - Server Action（認証 + Zod + 認可の3点セット）
// - Client Component は子コンポーネントとして最小化
// - taint API による機密データの誤露出防止
// - セマンティック HTML + 適切な aria 属性

import { Suspense } from 'react';
import { redirect } from 'next/navigation';

import { auth } from '@/lib/auth';
import { getUserProfile } from '@/lib/users';
import { ProfileForm } from '@/components/feature/ProfileForm';

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Profile',
  description: 'Manage your profile settings',
};

// 動的レンダリング（認証コンテキストに依存するため明示）
export const dynamic = 'force-dynamic';

export default async function ProfilePage(): Promise<JSX.Element> {
  // 認証ガード（Middleware は補助的、ページでも必ずチェック）
  const session = await auth();
  if (!session?.user) {
    redirect('/login?next=/profile');
  }

  // server-only モジュール経由で取得（passwordHash 等は taint で保護されている）
  const profile = await getUserProfile(session.user.id);

  return (
    <main className="container mx-auto py-8" aria-labelledby="profile-heading">
      <h1 id="profile-heading" className="text-2xl font-bold">
        Profile Settings
      </h1>

      <Suspense fallback={<p role="status">Loading...</p>}>
        {/* Client Component に渡すデータは最小限のフィールドのみ */}
        <ProfileForm
          initialName={profile.name}
          initialBio={profile.bio ?? ''}
        />
      </Suspense>
    </main>
  );
}

// File: components/feature/ProfileForm.tsx
'use client';

import { useState, useTransition } from 'react';

import { updateProfile } from '@/app/actions/update-profile';

type ProfileFormProps = {
  readonly initialName: string;
  readonly initialBio: string;
};

type FormState =
  | { status: 'idle' }
  | { status: 'success' }
  | { status: 'error'; message: string };

export function ProfileForm({
  initialName,
  initialBio,
}: ProfileFormProps): JSX.Element {
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<FormState>({ status: 'idle' });

  const handleSubmit = (formData: FormData): void => {
    startTransition(async () => {
      const result = await updateProfile(formData);
      if (result.ok) {
        setState({ status: 'success' });
      } else {
        // サーバ側で正規化されたエラーメッセージのみ受領
        setState({ status: 'error', message: result.error });
      }
    });
  };

  return (
    <form action={handleSubmit} className="mt-6 space-y-4" noValidate>
      <div>
        <label htmlFor="name" className="block text-sm font-medium">
          Name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          defaultValue={initialName}
          required
          maxLength={100}
          aria-describedby="name-help"
          className="mt-1 block w-full rounded border-gray-300"
        />
        <p id="name-help" className="text-xs text-gray-500">
          1-100 characters.
        </p>
      </div>

      <div>
        <label htmlFor="bio" className="block text-sm font-medium">
          Bio
        </label>
        <textarea
          id="bio"
          name="bio"
          defaultValue={initialBio}
          maxLength={500}
          rows={4}
          className="mt-1 block w-full rounded border-gray-300"
        />
      </div>

      <button
        type="submit"
        disabled={isPending}
        aria-busy={isPending}
        className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
      >
        {isPending ? 'Saving...' : 'Save'}
      </button>

      {state.status === 'success' && (
        <p role="status" className="text-green-600">
          Profile updated.
        </p>
      )}
      {state.status === 'error' && (
        <p role="alert" className="text-red-600">
          {state.message}
        </p>
      )}
    </form>
  );
}

// File: components/feature/ProfileForm.tsx
'use client';

import { useState, useTransition } from 'react';

import { updateProfile } from '@/app/actions/update-profile';

type ProfileFormProps = {
  readonly initialName: string;
  readonly initialBio: string;
};

type FormState =
  | { status: 'idle' }
  | { status: 'success' }
  | { status: 'error'; message: string };

export function ProfileForm({
  initialName,
  initialBio,
}: ProfileFormProps): JSX.Element {
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<FormState>({ status: 'idle' });

  const handleSubmit = (formData: FormData): void => {
    startTransition(async () => {
      const result = await updateProfile(formData);
      if (result.ok) {
        setState({ status: 'success' });
      } else {
        // サーバ側で正規化されたエラーメッセージのみ受領
        setState({ status: 'error', message: result.error });
      }
    });
  };

  return (
    <form action={handleSubmit} className="mt-6 space-y-4" noValidate>
      <div>
        <label htmlFor="name" className="block text-sm font-medium">
          Name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          defaultValue={initialName}
          required
          maxLength={100}
          aria-describedby="name-help"
          className="mt-1 block w-full rounded border-gray-300"
        />
        <p id="name-help" className="text-xs text-gray-500">
          1-100 characters.
        </p>
      </div>

      <div>
        <label htmlFor="bio" className="block text-sm font-medium">
          Bio
        </label>
        <textarea
          id="bio"
          name="bio"
          defaultValue={initialBio}
          maxLength={500}
          rows={4}
          className="mt-1 block w-full rounded border-gray-300"
        />
      </div>

      <button
        type="submit"
        disabled={isPending}
        aria-busy={isPending}
        className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
      >
        {isPending ? 'Saving...' : 'Save'}
      </button>

      {state.status === 'success' && (
        <p role="status" className="text-green-600">
          Profile updated.
        </p>
      )}
      {state.status === 'error' && (
        <p role="alert" className="text-red-600">
          {state.message}
        </p>
      )}
    </form>
  );
}

// File: app/actions/update-profile.ts
'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

// 入力スキーマ（境界での検証は MUST）
const UpdateProfileSchema = z.object({
  name: z.string().trim().min(1).max(100),
  bio: z.string().trim().max(500).optional().default(''),
});

type ActionResult =
  | { ok: true }
  | { ok: false; error: string };

export async function updateProfile(formData: FormData): Promise<ActionResult> {
  // 1) 認証チェック
  const session = await auth();
  if (!session?.user) {
    return { ok: false, error: 'Unauthorized' };
  }

  // 2) 入力バリデーション（safeParse で例外を投げない）
  const parsed = UpdateProfileSchema.safeParse({
    name: formData.get('name'),
    bio: formData.get('bio'),
  });
  if (!parsed.success) {
    return { ok: false, error: 'Invalid input' };
  }

  // 3) 認可: 自分のレコードのみ更新可能（resource ownership）
  const userId = session.user.id;

  try {
    await db.user.update({
      where: { id: userId },
      data: parsed.data,
    });
  } catch (err) {
    // 内部詳細はクライアントに返さない
    logger.error('updateProfile failed', { userId, err });
    return { ok: false, error: 'Failed to update profile' };
  }

  revalidatePath('/profile');
  return { ok: true };
}

// File: lib/users.ts
import 'server-only';

import {
  experimental_taintObjectReference,
  experimental_taintUniqueValue,
} from 'react';

import { db } from '@/lib/db';

export async function getUserProfile(userId: string) {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      bio: true,
      email: true,
      passwordHash: true, // 取得はするがクライアントには漏らさない
    },
  });

  // パスワードハッシュをクライアントへ渡そうとした瞬間にビルド/実行時エラー
  experimental_taintUniqueValue(
    'Do not pass passwordHash to the client',
    user,
    user.passwordHash,
  );
  // ユーザーオブジェクト全体をそのままクライアントへ渡すのを防ぐ
  experimental_taintObjectReference(
    'Do not pass the full user object to the client',
    user,
  );

  return user;
}