"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { clientFetch } from "@/lib/client-fetch";
import { Button } from "@/components/ui/Button/Button";
import { Card } from "@/components/ui/Card/Card";
import { TagLabel } from "@/components/ui/TagLabel/TagLabel";

// FREQ-312: 横に並ぶ枚数を公開 ITEM 一覧と一致させる。列指定は
// PublicItemGrid の ITEM_GRID_CLASS（FREQ-276）と同じ 2 / md:3 / 2xl:4。
// admin は md 以上でサイドナビ 224px が出るため、lg で 233px のフィルター
// サイドバーが出る /item 一覧と条件が近く、カード幅もほぼ一致する。
// 実測カード幅（内容幅）: 390:2列/169px(127) 768:3列/139px(95)
// 1280:3列/293px(248) 1920:4列/357px(312) 3840:4列/821px(776)
// ガターは公開側（2〜4px）を踏襲しない。admin カードは枠線があるため詰まりすぎる。
const ADMIN_ITEM_GRID_CLASS =
  "grid grid-cols-2 md:grid-cols-3 2xl:grid-cols-4 gap-x-3 gap-y-6 lg:gap-y-7";

interface AdminItem {
  id: number;
  name: string;
  category: string;
  price: number;
  image_url: string;
  status: "private" | "published";
}

interface ItemCardProps {
  item: AdminItem;
  onToggleStatus: (id: number, currentStatus: "private" | "published") => void;
  onDelete: (id: number) => void;
}

function ItemCard({ item, onToggleStatus, onDelete }: ItemCardProps) {
  const priceLabel = `¥${item.price.toLocaleString()}`;

  return (
    <Card className="overflow-hidden p-0" size="md">
      <Image
        alt={item.name}
        className="w-full aspect-3/4 object-cover"
        src={item.image_url || "/placeholder.png"}
        width={300}
        height={400}
        unoptimized
      />
      {/* Card 自体が φ 由来の約21pxパディングを持つ（className の p-0 は
          Card.css に負けて効かない）。ここで更に p-4 を足すと 768px 帯の
          カード139px中66pxがパディングになり内容が潰れるため padding は持たない。 */}
      <div className="space-y-3">
        {/* 公開状態は BASIC TAG（角丸なし）、カテゴリは ROUNDED TAG。
            同じ 2xs で揃えつつ、solid/outline と subtle で優先度を分ける（対比）。
            ACCESSORIES のような長いカテゴリでも行がはみ出さず、かつ
            カテゴリ名の長短でカード内の縦位置がずれないよう常に2段に積む（整列・反復）。 */}
        <div className="flex w-full flex-col items-start gap-1">
          <TagLabel
            variant={item.status === "published" ? "solid" : "outline"}
            size="2xs"
          >
            {item.status === "published" ? "公開中" : "非公開"}
          </TagLabel>
          <TagLabel
            variant="subtle"
            rounded
            size="2xs"
            className="w-full lg:w-auto lg:max-w-full"
          >
            <span className="block min-w-0 truncate">{item.category}</span>
          </TagLabel>
        </div>
        <h4 className="text-base text-black font-acumin">{item.name}</h4>
        <p className="text-sm text-black font-acumin">{priceLabel}</p>
        {/* FREQ-310: 主要動作の編集を全幅の1行目に置き、副次的な公開切替と削除を
            2行目に分ける（対比）。 */}
        <div className="space-y-2 pt-2">
          <Button
            className="w-full font-acumin"
            href={`/admin/item/edit/${item.id}`}
            variant="primary"
            size="sm"
          >
            編集
          </Button>
          {/* md 帯（768〜1023px）はカード幅が約139pxまで縮み2分割だとボタンが
              28pxに潰れるため縦積みに戻す。lg 以上は横2分割。 */}
          <div className="grid grid-cols-2 md:grid-cols-1 lg:grid-cols-2 gap-2">
            <Button
              onClick={() => onToggleStatus(item.id, item.status)}
              variant="secondary"
              size="sm"
              className="font-acumin"
            >
              {item.status === "published" ? "非公開" : "公開"}
            </Button>
            <Button
              onClick={() => onDelete(item.id)}
              variant="secondary"
              size="sm"
              className="font-acumin"
            >
              削除
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

export default function ItemSection() {
  const [items, setItems] = useState<AdminItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchItems = async () => {
    try {
      const res = await clientFetch("/api/admin/items");
      if (!res.ok) {
        throw new Error("Failed to fetch items");
      }

      const json = await res.json();
      setItems(json.data || []);
    } catch (error) {
      console.error("Failed to load items:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchItems();
  }, []);

  const handleToggleStatus = async (
    id: number,
    currentStatus: "private" | "published",
  ) => {
    const nextStatus = currentStatus === "published" ? "private" : "published";

    try {
      const res = await clientFetch(`/api/admin/items/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });

      if (!res.ok) {
        throw new Error("Failed to update status");
      }

      await fetchItems();
    } catch (error) {
      console.error("Failed to toggle item status:", error);
      alert("ステータスの更新に失敗しました");
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("この商品を削除してもよろしいですか？")) {
      return;
    }

    try {
      const res = await clientFetch(`/api/admin/items/${id}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        throw new Error("Failed to delete item");
      }

      await fetchItems();
    } catch (error) {
      console.error("Failed to delete item:", error);
      alert("商品の削除に失敗しました");
    }
  };

  if (loading) {
    return <div className="text-center py-12 font-acumin">読み込み中...</div>;
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-12 text-[#474747] font-acumin">
        商品がありません
      </div>
    );
  }

  return (
    <div>
      <div className={ADMIN_ITEM_GRID_CLASS} data-testid="admin-item-grid">
        {items.map((item) => (
          <ItemCard
            key={item.id}
            item={item}
            onToggleStatus={handleToggleStatus}
            onDelete={handleDelete}
          />
        ))}
      </div>
    </div>
  );
}
