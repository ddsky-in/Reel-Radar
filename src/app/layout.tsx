import type { Metadata } from 'next';
import '@fontsource/host-grotesk/latin-400.css';
import '@fontsource/host-grotesk/latin-500.css';
import '@fontsource/host-grotesk/latin-600.css';
import '@fontsource/host-grotesk/latin-700.css';
import './globals.css';
import './research-theme.css';
import './controls.css';
import './dashboard.css';
import './settings.css';
import './carousels.css';

export const metadata: Metadata = {
  title: 'ReelRadar — Competitor Reel research',
  description: 'Private workspace for tracking competitor Reels, saved research, and collection activity.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Browser extensions may add body attributes before React hydrates; keep suppression on this wrapper.
  return <html lang="en"><body suppressHydrationWarning>{children}</body></html>;
}
