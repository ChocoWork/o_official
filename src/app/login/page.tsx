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

export default function LoginPage() {
  return <AuthTabs initialTab="login" />;
}
