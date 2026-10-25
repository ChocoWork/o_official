// File: src/app/admin/packing/page.tsx
import PackingSection from '@/components/PackingSection';

/** 表示の可否は部品の GET の成功で決める（権限は窓口と DB が守る）。 */
export default function PackingPage(): React.JSX.Element {
  return (
    <main className="mx-auto w-full min-w-0 max-w-6xl px-4 py-8 md:px-8">
      <PackingSection />
    </main>
  );
}
