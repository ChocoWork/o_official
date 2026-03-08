'use client';

import { NewsForm } from '../NewsForm';

export default function CreateNewsPage() {
  return <NewsForm submitUrl="/api/admin/news" submitMethod="POST" />;
}