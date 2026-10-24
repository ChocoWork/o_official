/**
 * 管理画面の LOOK の作成の頁（src/app/admin/look/create/page.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-LOOK-127
 * @design DD-LOOK-061
 * @remarks 作成と編集で同じ入力のフォームを使い回して欄の決まりを1つにするため、この頁は送り先と送り方だけを渡す。
 */
'use client';

import { LookForm } from '../LookForm';

export default function AdminLookCreatePage() {
	return <LookForm submitUrl="/api/admin/looks" submitMethod="POST" />;
}
