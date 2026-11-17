'use client';

import { createContext } from 'react';
import type { Reel, ReelQuery } from '../lib/types';

/** The app opens a detail page; isolated cards retain their dialog fallback. */
export const ReelNavigationContext = createContext<((reel: Reel, workspaceId: string, query?: ReelQuery) => void) | null>(null);
export const ReelHrefContext = createContext<((reel: Reel, workspaceId: string, query?: ReelQuery) => string) | null>(null);
export const ReelListContext = createContext<ReelQuery | undefined>(undefined);
