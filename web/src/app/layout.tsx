import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AuthProvider } from '@/lib/auth-context';
import { PwaRegister } from '@/components/pwa-register';
import { ErrorReporter } from '@/components/error-reporter';

export const metadata: Metadata = {
  title: 'SJCA Market Manager',
  description: 'Farmers market management for St. Joseph Center of Arkansas',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'SJCA Markets',
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
  themeColor: '#2A5E33',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500..800&family=Source+Sans+3:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-sans bg-bg min-h-screen antialiased">
        <AuthProvider>
          {children}
        </AuthProvider>
        <PwaRegister />
        <ErrorReporter />
      </body>
    </html>
  );
}
