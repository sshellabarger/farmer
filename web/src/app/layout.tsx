import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AuthProvider } from '@/lib/auth-context';
import { PwaRegister } from '@/components/pwa-register';

export const metadata: Metadata = {
  title: 'FarmLink — Arkansas Local Food Network',
  description: 'Text-first platform connecting local farms and markets',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'FarmLink',
    statusBarStyle: 'default',
  },
  icons: {
    icon: '/icon-192.png',
    apple: '/apple-touch-icon.png',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#2E6B34',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600;700;800;900&family=Source+Sans+3:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-sans bg-bg min-h-screen antialiased">
        <AuthProvider>
          {children}
        </AuthProvider>
        <PwaRegister />
      </body>
    </html>
  );
}
