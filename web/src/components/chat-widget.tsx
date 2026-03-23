'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { Icon } from './icons';

interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  created_at: string;
}

export function ChatWidget() {
  const { user, isAuthenticated } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const phone = user?.phone || '';
  const formattedPhone = (() => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return phone.startsWith('+') ? phone : `+${digits}`;
  })();

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Focus input when expanded
  useEffect(() => {
    if (expanded && inputRef.current) {
      inputRef.current.focus();
    }
  }, [expanded]);

  // Load history on first expand
  const loadHistory = useCallback(async () => {
    if (loaded || !formattedPhone) return;
    try {
      const res = await fetch(`/api/sms/history/${encodeURIComponent(formattedPhone)}`);
      const data = await res.json();
      setMessages(data.messages || []);
    } catch {
      setMessages([]);
    }
    setLoaded(true);
  }, [loaded, formattedPhone]);

  if (!isAuthenticated || !user) return null;

  const handleExpand = () => {
    setExpanded(true);
    loadHistory();
  };

  const sendMessage = async () => {
    if (!input.trim() || sending) return;

    const userMsg: Message = {
      id: `local-${Date.now()}`,
      direction: 'inbound',
      body: input.trim(),
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setSending(true);

    try {
      const res = await fetch('/api/sms/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: formattedPhone, message: userMsg.body }),
      });
      const data = await res.json();

      const botMsg: Message = {
        id: `bot-${Date.now()}`,
        direction: 'outbound',
        body: data.response || data.error || 'No response',
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, botMsg]);
    } catch {
      const errorMsg: Message = {
        id: `err-${Date.now()}`,
        direction: 'outbound',
        body: 'Connection error. Is the API server running?',
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleMinimizedSend = () => {
    if (!input.trim() || sending) return;
    setExpanded(true);
    if (!loaded) loadHistory();
    // Small delay to let state settle before sending
    setTimeout(() => sendMessage(), 50);
  };

  const handleImageUpload = async (file: File) => {
    setSending(true);
    setExpanded(true);
    if (!loaded) await loadHistory();

    // Show upload message
    const uploadMsg: Message = {
      id: `local-${Date.now()}`,
      direction: 'inbound',
      body: `📷 Uploading photo...`,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, uploadMsg]);

    try {
      // Upload the image
      const formData = new FormData();
      formData.append('file', file);
      const uploadRes = await fetch('/api/uploads', { method: 'POST', body: formData });
      const uploadData = await uploadRes.json();

      if (!uploadRes.ok) throw new Error(uploadData.error || 'Upload failed');

      // Update the upload message with the image
      setMessages((prev) =>
        prev.map((m) =>
          m.id === uploadMsg.id
            ? { ...m, body: `📷 Photo uploaded` }
            : m,
        ),
      );

      // Send chat message with photo context
      const chatMessage = input.trim()
        ? `[Photo: ${uploadData.url}] ${input.trim()}`
        : `I've uploaded a photo: ${uploadData.url}. Please use this for my inventory listing.`;
      setInput('');

      const res = await fetch('/api/sms/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: formattedPhone, message: chatMessage }),
      });
      const data = await res.json();

      const botMsg: Message = {
        id: `bot-${Date.now()}`,
        direction: 'outbound',
        body: data.response || data.error || 'No response',
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, botMsg]);
    } catch {
      const errorMsg: Message = {
        id: `err-${Date.now()}`,
        direction: 'outbound',
        body: 'Failed to upload image. Please try again.',
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="sticky top-[52px] sm:top-[56px] z-40 border-b border-earth-200 bg-white shadow-sm">
      <div className="max-w-[1140px] mx-auto">
        {/* ── Minimized bar ── */}
        {!expanded && (
          <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-6 py-2">
            <button
              onClick={handleExpand}
              className="flex items-center gap-2 bg-transparent border-none cursor-pointer shrink-0"
            >
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center text-white shrink-0"
                style={{ background: 'linear-gradient(135deg, #2d5016, #4a7c28)' }}
              >
                <Icon name="msg" size={16} />
              </div>
              <span className="text-xs sm:text-sm font-bold text-earth-900 whitespace-nowrap">AI Chat</span>
            </button>
            <div className="flex-1 flex items-center gap-2 min-w-0">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleMinimizedSend();
                  }
                }}
                onFocus={() => { if (!loaded) loadHistory(); }}
                placeholder="Ask anything..."
                className="flex-1 min-w-0 px-3 py-1.5 sm:py-2 border border-earth-200 rounded-xl text-sm focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100 bg-earth-15"
              />
              <button
                onClick={handleMinimizedSend}
                disabled={!input.trim() || sending}
                className="px-3 py-1.5 sm:py-2 rounded-xl font-semibold text-xs sm:text-sm text-white border-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                style={{ background: 'linear-gradient(135deg, #2d5016, #4a7c28)' }}
              >
                {sending ? '...' : 'Send'}
              </button>
            </div>
          </div>
        )}

        {/* ── Expanded chat ── */}
        {expanded && (
          <div className="flex flex-col" style={{ height: 'min(380px, 50vh)' }}>
            {/* Header bar */}
            <div className="flex items-center justify-between px-3 sm:px-6 py-2 border-b border-earth-100">
              <div className="flex items-center gap-2">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-white shrink-0"
                  style={{ background: 'linear-gradient(135deg, #2d5016, #4a7c28)' }}
                >
                  <Icon name="msg" size={16} />
                </div>
                <div>
                  <div className="font-bold text-sm text-earth-900">FarmLink AI</div>
                  <div className="text-[10px] sm:text-[11px] text-earth-500 truncate max-w-[200px] sm:max-w-none">
                    Ask about inventory, orders, or markets
                  </div>
                </div>
              </div>
              <button
                onClick={() => setExpanded(false)}
                className="text-earth-400 hover:text-earth-700 bg-earth-50 hover:bg-earth-100 w-8 h-8 rounded-lg cursor-pointer transition-colors flex items-center justify-center border-none shrink-0 text-sm font-bold"
                aria-label="Minimize chat"
              >
                ▴
              </button>
            </div>

            {/* Messages */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 sm:px-6 py-3 space-y-2.5" style={{ background: '#f7f5f0' }}>
              {messages.length === 0 && !sending && (
                <div className="text-center text-earth-400 text-sm py-6">
                  <div className="text-2xl mb-2">💬</div>
                  <div className="font-semibold text-earth-500 mb-1">Chat with FarmLink AI</div>
                  <div className="text-xs text-earth-400">Try: &quot;What&apos;s available?&quot; or &quot;Show my orders&quot;</div>
                </div>
              )}
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.direction === 'inbound' ? 'justify-end' : 'justify-start'}`}
                  style={{ animation: 'fadeSlide 0.2s ease' }}
                >
                  <div
                    className={`max-w-[85%] sm:max-w-[75%] px-3 sm:px-4 py-2 rounded-2xl text-[13px] leading-relaxed whitespace-pre-wrap ${
                      msg.direction === 'inbound'
                        ? 'bg-farm-600 text-white rounded-br-md'
                        : 'bg-white text-earth-800 shadow-sm border border-earth-100 rounded-bl-md'
                    }`}
                  >
                    {msg.body}
                  </div>
                </div>
              ))}
              {sending && (
                <div className="flex justify-start">
                  <div className="bg-white text-earth-400 px-4 py-3 rounded-2xl rounded-bl-md shadow-sm border border-earth-100 text-sm">
                    <span className="inline-flex gap-1">
                      <span className="animate-bounce" style={{ animationDelay: '0ms' }}>·</span>
                      <span className="animate-bounce" style={{ animationDelay: '150ms' }}>·</span>
                      <span className="animate-bounce" style={{ animationDelay: '300ms' }}>·</span>
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Input */}
            <div className="border-t border-earth-100 px-3 sm:px-6 py-2 flex items-center gap-2 bg-white shrink-0">
              <label className="shrink-0 cursor-pointer">
                <span className="w-9 h-9 flex items-center justify-center rounded-xl bg-earth-50 hover:bg-earth-100 transition-colors text-lg">
                  📷
                </span>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  disabled={sending}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleImageUpload(file);
                    e.target.value = '';
                  }}
                />
              </label>
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a message..."
                disabled={sending}
                className="flex-1 px-3 sm:px-4 py-2 border border-earth-200 rounded-xl text-sm focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100 disabled:opacity-50"
              />
              <button
                onClick={sendMessage}
                disabled={!input.trim() || sending}
                className="px-4 py-2 bg-farm-600 text-white rounded-xl font-semibold text-sm hover:bg-farm-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer border-none"
              >
                Send
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
