import type { Metadata } from 'next';
import React from "react";
import AuthTabs from "@/components/AuthTabs";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: 'LOGIN | Le Fil des Heures',
    description:
      'Le Fil des Heures のログインページです。メールアドレスとパスワード、または Google アカウントでサインインできます。',
    openGraph: {
      title: 'LOGIN | Le Fil des Heures',
      description:
        'Le Fil des Heures のログインページです。メールアドレスとパスワード、または Google アカウントでサインインできます。',
      images: ['/mainphoto.png'],
    },
  };
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const tabParam = params?.tab;
  const initialTab = tabParam === 'register' ? 'register' : 'login';
  const emailParam = params?.email;
  const initialEmail = typeof emailParam === 'string' ? emailParam : '';

  return <AuthTabs initialTab={initialTab} initialEmail={initialEmail} />;
}
