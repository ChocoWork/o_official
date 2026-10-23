// File: src/app/admin/settings/permissions/page.tsx
import RolePermissionsSection from '@/components/RolePermissionsSection';

/** 表の表示可否は部品のGET成功で決める。 */
export default function RolePermissionsPage(): React.JSX.Element {
  return (
    <main className="mx-auto w-full min-w-0 max-w-6xl px-4 py-8 md:px-8">
      <RolePermissionsSection />
    </main>
  );
}
