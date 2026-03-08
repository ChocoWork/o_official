'use client';

import { LookForm } from '../LookForm';

export default function AdminLookCreatePage() {
	return <LookForm submitUrl="/api/admin/looks" submitMethod="POST" />;
}
