'use client';

import { useEffect } from 'react';
import { AlertCircle } from 'lucide-react';
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return <div className="route-error"><AlertCircle size={30}/><h1>Unable to load page</h1><p>Please try again.</p><button className="button button-accent" onClick={reset}>Try again</button></div>;
}
