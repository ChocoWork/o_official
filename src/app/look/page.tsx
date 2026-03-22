import { PublicLookGrid } from '@/features/look/components/PublicLookGrid';

export default async function LookPage() {
    return (
        <main className="pt-32 pb-20 px-6 lg:px-12">
            <div className="max-w-7xl mx-auto">
                <PublicLookGrid variant="catalog" />
            </div>
        </main>
    );
}
