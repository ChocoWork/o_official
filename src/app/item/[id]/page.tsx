// Server Component: generateMetadata で SEO メタ情報を設定し、
// クライアントコンポーネント ItemDetailClient にデータ取得を委譲する (FR-ITEM-DETAIL-009)
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import ItemDetailClient from "./ItemDetailClient";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const supabase = await createClient();

  const { data: item } = await supabase
    .from("items")
    .select("name, description, image_url")
    .eq("id", id)
    .eq("status", "published")
    .maybeSingle();

  if (!item) {
    return { title: "Item Not Found | Le Fil des Heures" };
  }

  const title = `${item.name} | Le Fil des Heures`;
  const description =
    (item.description as string | null) ??
    `${item.name} - Le Fil des Heures 公式オンラインストア`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: item.image_url ? [{ url: item.image_url as string }] : [],
    },
  };
}

export default async function Page({ params }: Props) {
  const { id } = await params;
  return <ItemDetailClient id={id} />;
}
