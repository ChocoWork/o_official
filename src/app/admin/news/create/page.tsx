/**
 * 記事の作成のページ（src/app/admin/news/create/page.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-NEWS-143
 * @design DD-NEWS-062
 * @remarks 送り先と送り方が決まっているので固定の値でフォームを包むだけにし、欄と画像の決まりはフォームの1か所に置く。
 * ページでは画面を守らず、送った時に窓口が権限で断る。
 */
'use client';

import { NewsForm } from '../NewsForm';

export default function CreateNewsPage() {
  return <NewsForm submitUrl="/api/admin/news" submitMethod="POST" />;
}