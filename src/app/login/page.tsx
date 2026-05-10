import type { Metadata } from 'next';
import React from "react";
import LoginModal from "@/components/LoginModal";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: 'LOGIN | Le Fil des Heures',
    description:
      'Le Fil des Heures のログインページです。メールOTP認証またはGoogleアカウントでサインインできます。',
    openGraph: {
      title: 'LOGIN | Le Fil des Heures',
      description:
        'Le Fil des Heures のログインページです。メールOTP認証またはGoogleアカウントでサインインできます。',
      images: ['/mainphoto.png'],
    },
  };
}

export default function LoginPage() {
  return (
    <LoginModal open={true} />
  );
}
