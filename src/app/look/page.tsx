import { PublicLookGrid } from '@/features/look/components/PublicLookGrid';

export default async function LookPage() {
    return (
        <div className="pb-10 sm:pb-14 px-6 lg:px-12">
            <div className="max-w-7xl mx-auto">
                <PublicLookGrid variant="catalog" />
            </div>
        </div>
    );
}
