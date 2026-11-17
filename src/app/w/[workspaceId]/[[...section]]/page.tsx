import { Suspense } from 'react';
import { App } from '@/components/app';

export const dynamic = 'force-dynamic';
export default async function WorkspacePage({ params }: { params: Promise<{ workspaceId: string; section?: string[] }> }) {
  const { workspaceId, section } = await params;
  return <Suspense fallback={<div className="route-loading">Getting your research ready…</div>}><App workspaceId={workspaceId} section={section?.length === 1 ? section[0] : section?.length ? 'unknown' : 'overview'}/></Suspense>;
}
