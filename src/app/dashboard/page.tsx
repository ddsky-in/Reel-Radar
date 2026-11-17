import { Suspense } from 'react';
import type { Metadata } from 'next';
import { App } from '@/components/app';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Dashboard | ReelRadar' };
export default function Page() { return <Suspense fallback={<div className="route-loading">Getting your research ready…</div>}><App section="overview"/></Suspense>; }
