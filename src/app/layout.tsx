import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import Script from 'next/script';
import { THEME_BOOT_SCRIPT } from '@/lib/theme';
import './globals.css';

export const metadata: Metadata = {
  title: 'Festival Broadcaster',
  description: 'Self-hosted WhatsApp festival greetings with safe pacing',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fff8eb' },
    { media: '(prefers-color-scheme: dark)', color: '#141110' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The boot script adds the "dark" class before React hydrates, hence suppressHydrationWarning.
    <html lang="en" suppressHydrationWarning>
      <body>
        {/* Sets light/dark before the first paint, so there's no flash of the wrong theme. */}
        <Script id="theme-boot" strategy="beforeInteractive">
          {THEME_BOOT_SCRIPT}
        </Script>
        {children}
      </body>
    </html>
  );
}
