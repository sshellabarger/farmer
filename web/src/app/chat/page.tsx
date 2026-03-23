'use client';

import { Header } from '@/components/header';
import { LiveChat } from '@/components/live-chat';

export default function ChatPage() {
  return (
    <div className="min-h-screen bg-earth-15">
      <Header />
      <div className="max-w-[480px] mx-auto px-6 py-6 h-[calc(100vh-72px)]">
        <LiveChat />
      </div>
    </div>
  );
}
