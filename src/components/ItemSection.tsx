"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { clientFetch } from "@/lib/client-fetch";
import { Button } from "@/components/ui/Button/Button";
import { Card } from "@/components/ui/Card/Card";
import { TagLabel } from "@/components/ui/TagLabel/TagLabel";
import { buildItemDeleteGuidance } from "@/lib/items/item-delete-guidance";

// FREQ-312: 横に並ぶ枚数を公開 ITEM 一覧と一致させる。列指定は
// PublicItemGrid の ITEM_GRID_CLASS（FREQ-276）と同じ 2 / md:3 / 2xl:4。
// FREQ-315 でサイドナビの出現位置を lg に揃えたので、lg で 233px のフィルター
// サイドバーが出る /item 一覧とカードの条件が完全に一致する。
// 実測カード幅（内容幅）: 390:2列/169px(152) 768:3列/213px(195)
// 1024:3列/219px(174) 1280:3列/293px(248) 1920:4列/357px(312) 3840:4列/821px(776)
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
  /** 注文・在庫の記録・決済中のある商品は false（R-44） */
  canDelete?: boolean;
  deleteBlockedReasons?: string[];
}

interface ItemCardProps {
  item: AdminItem;
  onToggleStatus: (id: number, currentStatus: "private" | "published") => void;
  onDelete: (item: AdminItem) => void;
}

function ItemCard({ item, onToggleStatus, onDelete }: ItemCardProps) {
  const priceLabel = `¥${item.price.toLocaleString()}`;

  return (
    <Card className="admin-item-card overflow-hidden p-0" size="md">
      {/* FREQ-313: 画像とテキスト群は別グループ。境界に --card-media-gap（font）の
          余白を置いて切り分ける（近接）。 */}
      <Image
        alt={item.name}
        className="mb-[var(--card-media-gap)] w-full aspect-3/4 object-cover"
        src={item.image_url || "/placeholder.png"}
        width={300}
        height={400}
        unoptimized
      />
      {/* Card 自体が φ 由来のパディングを持つ（className の p-0 は Card.css に
          負けて効かない）。lg 未満は globals.css の .admin-item-card で font/φ
          まで詰め、狭い帯でもタグ行・操作列が1行に収まるようにしている。 */}
      <div className="space-y-3">
        {/* 公開状態は BASIC TAG（角丸なし）、カテゴリは ROUNDED TAG。
            同じ 2xs で揃えつつ、solid/outline と subtle で優先度を分ける（対比）。
            FREQ-313: 2つを横一列に並べ、幅が足りないときはカテゴリだけを
            省略記号で切り詰めてカードからはみ出させない。タグ同士の間隔は
            --card-gap（font ÷ φ）。画像との境界（font）より狭く、名称↔価格の行間
            より広い、φ ラダーの中段に置く（近接・反復）。 */}
        <div
          className="admin-item-card-tags flex w-full min-w-0 items-center gap-[var(--card-gap)]"
          data-testid="admin-item-tags"
        >
          <TagLabel
            variant={item.status === "published" ? "solid" : "outline"}
            size="2xs"
            className="shrink-0"
          >
            {item.status === "published" ? "公開中" : "非公開"}
          </TagLabel>
          <TagLabel variant="subtle" rounded size="2xs" className="min-w-0">
            <span className="block min-w-0 truncate">{item.category}</span>
          </TagLabel>
        </div>
        {/* FREQ-313: 商品名と価格は公開 ITEM 一覧カード（ItemCardInfo）と同じ
            --lk-size-2xs / weight 400。2行で1つの塊なので間隔も一段詰める（近接）。 */}
        <div className="space-y-0.5">
          <h4
            className="text-black font-acumin"
            data-testid="admin-item-name"
            style={{ fontSize: "var(--lk-size-2xs)", fontWeight: 400 }}
          >
            {item.name}
          </h4>
          <p
            className="text-black font-acumin"
            data-testid="admin-item-price"
            style={{ fontSize: "var(--lk-size-2xs)", fontWeight: 400 }}
          >
            {priceLabel}
          </p>
        </div>
        {/* FREQ-313: 編集 / 公開切替 / 削除を1行3等分で並べる（FREQ-310-REQ-02 の
            2段構成を撤回）。列は minmax(0,1fr) なのでセル幅がボタン幅を決め、
            左右パディングは globals.css の .admin-item-actions で 0 にしている。 */}
        <div
          className="admin-item-actions grid grid-cols-3 gap-1 pt-2"
          data-testid="admin-item-actions"
        >
          <Button
            className="w-full font-acumin"
            href={`/admin/item/edit/${item.id}`}
            variant="primary"
            size="sm"
          >
            編集
          </Button>
          <Button
            onClick={() => onToggleStatus(item.id, item.status)}
            variant="secondary"
            size="sm"
            className="w-full font-acumin"
          >
            {item.status === "published" ? "非公開" : "公開"}
          </Button>
          <Button
            onClick={() => onDelete(item)}
            variant="secondary"
            size="sm"
            className="w-full font-acumin"
          >
            削除
          </Button>
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

  const handleDelete = async (item: AdminItem) => {
    // 削除できない商品は、送らずに非公開を促す（R-44）
    if (item.canDelete === false) {
      alert(buildItemDeleteGuidance(item.deleteBlockedReasons ?? []));
      return;
    }

    if (!confirm("この商品を削除してもよろしいですか？")) {
      return;
    }

    try {
      const res = await clientFetch(`/api/admin/items/${item.id}`, {
        method: "DELETE",
      });

      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        alert(
          typeof body.error === "string" && body.error.length > 0 && body.error.length <= 200
            ? body.error
            : buildItemDeleteGuidance([]),
        );
        await fetchItems();
        return;
      }

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
