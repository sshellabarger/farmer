'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { Header } from '@/components/header';
import { LiveChat } from '@/components/live-chat';

// Admin-only SMS simulator: it lets the operator chat as any phone number,
// so it must never be reachable by regular users or anonymous visitors.
export default function ChatPage() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const isAdmin = isAuthenticated && user?.role === 'admin';

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      router.push('/login');
    } else if (!isAdmin) {
      router.push('/');
    }
  }, [isLoading, isAuthenticated, isAdmin, router]);

  if (!isAdmin) return null;

  return (
    <div className="min-h-screen bg-earth-15">
      <Header />
      <div className="max-w-[480px] mx-auto px-6 py-6 h-[calc(100vh-72px)]">
        <LiveChat />
      </div>
    </div>
  );
}
