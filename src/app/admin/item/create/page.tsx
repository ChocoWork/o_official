'use client';

import { ItemForm } from '../ItemForm';

export default function AdminItemCreatePage() {
  return (
    <ItemForm
      submitUrl="/api/admin/items"
      submitMethod="POST"
    />
  );
}
