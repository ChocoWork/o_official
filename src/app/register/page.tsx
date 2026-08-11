import type { Metadata } from 'next';
import React from "react";
import AuthTabs from "@/components/AuthTabs";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: 'REGISTER | Le Fil des Heures',
    description:
      'Le Fil des Heures の会員登録ページです。メールアドレスとパスワード、または Google アカウントで登録できます。',
    openGraph: {
      title: 'REGISTER | Le Fil des Heures',
      description:
        'Le Fil des Heures の会員登録ページです。メールアドレスとパスワード、または Google アカウントで登録できます。',
      images: ['/mainphoto.png'],
    },
  };
}

export default async function RegisterPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const emailParam = params?.email;
  const initialEmail = typeof emailParam === 'string' ? emailParam : '';

  return <AuthTabs initialTab="register" initialEmail={initialEmail} />;
}
