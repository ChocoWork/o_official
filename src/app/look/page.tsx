import { PublicLookGrid } from '@/features/look/components/PublicLookGrid';

export default async function LookPage() {
    return (
        <div className="pt-6 sm:pt-8 lg:pt-12 pb-12 sm:pb-16 lg:pb-20 px-5 sm:px-6 lg:px-12">
            <div className="max-w-7xl mx-auto">
                <PublicLookGrid variant="catalog" />
            </div>
        </div>
    );
}
