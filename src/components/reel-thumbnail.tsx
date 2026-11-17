'use client';

import { useState } from 'react';
import { ImageOff } from 'lucide-react';
import type { Reel } from '../lib/types';
import { DurationBadge } from './duration-badge';

export function Thumbnail({ reel, compact = false }: { reel: Reel; compact?: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = Boolean(reel.thumbnail_url && failedUrl !== reel.thumbnail_url);
  const placeholder = reel.provider.startsWith('mock') ? 'Synthetic preview' : 'Thumbnail unavailable';
  return <div className={`thumbnail ${compact ? 'thumbnail-compact' : ''} ${showImage ? '' : 'thumbnail-placeholder'}`}>
    {/* External provider images stay uncropped and are not proxied. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {showImage ? <img src={reel.thumbnail_url!} alt={`Thumbnail for @${reel.username}'s Reel`} loading="lazy" onError={() => setFailedUrl(reel.thumbnail_url)}/> : <div className="thumbnail-fallback" aria-label={placeholder}><ImageOff size={24} aria-hidden="true"/>{!compact && <span>{placeholder}</span>}</div>}
    <DurationBadge seconds={reel.duration_seconds}/>
  </div>;
}
