import { Suspense } from 'react';
import { App } from '@/components/app';
export const dynamic = 'force-dynamic';
export default function Page() { return <Suspense fallback={<div className="route-loading">Getting your research ready…</div>}><App section="carousels"/></Suspense>; }
