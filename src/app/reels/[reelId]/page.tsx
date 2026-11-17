import { Suspense } from 'react';
import { App } from '@/components/app';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ reelId: string }> }) {
  const { reelId } = await params;
  return <Suspense fallback={<div className="route-loading">Loading Reel research…</div>}><App section="reels" reelId={reelId}/></Suspense>;
}
