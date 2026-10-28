/**
 * 管理画面の LOOK タブの一覧（src/components/LookSection.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-LOOK-126
 * @design DD-LOOK-060
 * @remarks 画面は利用者の端末で動き、守りは持たない。権限・回数の制限・監査は窓口（/api/admin/looks）が受け持つ。
 * 「新規作成」とカードの公開の切り替え・編集・削除は、窓口の応答の meta.canManage が真の時だけ出す。読み込み中・失敗・meta なし・偽は出さず、
 * 権限の無い人に押せない操作を見せない（SEC-LOOK-019。窓口の判定が本物で、画面の出し分けは案内）。
 * 「新規作成」は頁の役（admin）でなく権限で出し、0 件の一覧にも出す（最初の 1 件を作れるように。ADR-0166）。
 * 作った LOOK を直さずに出し入れできるよう、公開の切り替えは状態だけを反転して送る。
 * 消した LOOK は戻せないので押し間違いを防ぐ確かめを挟み、変更の後は一覧を取り直して窓口の結果を画面に映す。
 */
"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { clientFetch } from "@/lib/client-fetch";
import { Button } from "@/components/ui/Button/Button";
import { Card } from "@/components/ui/Card/Card";
import { TagLabel } from "@/components/ui/TagLabel/TagLabel";

type AdminLookItem = {
  id: number;
  season_year: number;
  season_type: "SS" | "AW";
  theme: string;
  image_urls: string[];
  status: "private" | "published";
};

export default function LookSection() {
  const [lookItems, setLookItems] = useState<AdminLookItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [canManage, setCanManage] = useState(false);

  const fetchLooks = async () => {
    try {
      const res = await clientFetch("/api/admin/looks");
      if (!res.ok) {
        // 回数の制限の 429 は no-store。本文を読まずに捨てるとブラウザが要求を開いたまま残す
        void res.arrayBuffer?.().catch(() => {});
        throw new Error("Failed to fetch looks");
      }

      const json = await res.json();
      setLookItems((json.data || []) as AdminLookItem[]);
      setCanManage(json.meta?.canManage === true);
    } catch (error) {
      console.error("Failed to load looks:", error);
      setCanManage(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchLooks();
  }, []);

  const handleToggleStatus = async (
    id: number,
    currentStatus: "private" | "published",
  ) => {
    const nextStatus = currentStatus === "published" ? "private" : "published";

    try {
      const res = await clientFetch(`/api/admin/looks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });

      if (!res.ok) {
        void res.arrayBuffer?.().catch(() => {});
        throw new Error("Failed to update status");
      }

      await fetchLooks();
    } catch (error) {
      console.error("Failed to toggle look status:", error);
      alert("ステータスの更新に失敗しました");
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("このLOOKを削除してもよろしいですか？")) {
      return;
    }

    try {
      const res = await clientFetch(`/api/admin/looks/${id}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        void res.arrayBuffer?.().catch(() => {});
        throw new Error("Failed to delete look");
      }

      await fetchLooks();
    } catch (error) {
      console.error("Failed to delete look:", error);
      alert("LOOKの削除に失敗しました");
    }
  };

  if (loading) {
    return <div className="text-center py-12 font-acumin">読み込み中...</div>;
  }

  // 「新規作成」は管理の権限（canManage）がある時だけ。0 件でも出す（出さないと最初の 1 件を作れない）
  const createButton = canManage ? (
    <div className="mb-6 flex justify-end">
      <Button href="/admin/look/create" variant="primary" size="sm" className="font-acumin">
        新規作成
      </Button>
    </div>
  ) : null;

  if (lookItems.length === 0) {
    return (
      <section>
        {createButton}
        <div className="text-center py-12 text-[#474747] font-acumin">
          LOOKがありません
        </div>
      </section>
    );
  }

  return (
    <section>
      {createButton}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
        {lookItems.map((item) => (
          <Card key={item.id} className="overflow-hidden p-0" size="md">
            <Image
              src={item.image_urls?.[0] || "/placeholder.png"}
              alt={item.theme}
              width={400}
              height={600}
              className="w-full aspect-2/3 object-cover bg-[#f5f5f5]"
              unoptimized
            />
            <div className="p-4 space-y-3">
              <div className="flex items-center space-x-2">
                <TagLabel
                  variant={item.status === "published" ? "solid" : "outline"}
                  size="md"
                >
                  {item.status === "published" ? "公開中" : "非公開"}
                </TagLabel>
              </div>
              <p className="lk-text-3xs text-[#474747] tracking-widest font-acumin">
                {item.season_year} {item.season_type}
              </p>
              <p className="lk-text-sm text-black font-acumin">{item.theme}</p>
              {canManage && (
                <div className="flex space-x-2 pt-2">
                  <Button
                    onClick={() => handleToggleStatus(item.id, item.status)}
                    variant="secondary"
                    size="sm"
                    className="flex-1 font-acumin"
                  >
                    {item.status === "published" ? "非公開" : "公開"}
                  </Button>
                  <Button
                    href={`/admin/look/edit/${item.id}`}
                    variant="secondary"
                    size="sm"
                    className="flex-1 font-acumin"
                  >
                    編集
                  </Button>
                  <Button
                    onClick={() => handleDelete(item.id)}
                    variant="primary"
                    size="sm"
                    className="font-acumin"
                  >
                    削除
                  </Button>
                </div>
              )}
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}
