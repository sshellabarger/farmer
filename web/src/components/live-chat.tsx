'use client';

import { useState, useRef, useEffect } from 'react';
import { Icon } from './icons';

interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  created_at: string;
}

interface LiveChatProps {
  defaultPhone?: string;
}

export function LiveChat({ defaultPhone = '' }: LiveChatProps) {
  const [phone, setPhone] = useState(defaultPhone);
  const [activePhone, setActivePhone] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Focus input after connecting
  useEffect(() => {
    if (connected && inputRef.current) {
      inputRef.current.focus();
    }
  }, [connected]);

  const formatPhone = (raw: string) => {
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return raw.startsWith('+') ? raw : `+${digits}`;
  };

  const startSession = async () => {
    const formatted = formatPhone(phone);
    setActivePhone(formatted);
    setConnected(true);

    // Load history
    try {
      const res = await fetch(`/api/sms/history/${encodeURIComponent(formatted)}`);
      const data = await res.json();
      setMessages(data.messages || []);
    } catch {
      setMessages([]);
    }
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
        body: JSON.stringify({ phone: activePhone, message: userMsg.body }),
      });
      const data = await res.json();

      const botMsg: Message = {
        id: `bot-${Date.now()}`,
        direction: 'outbound',
        body: data.response || data.error || 'No response',
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, botMsg]);
    } catch (err) {
      const errorMsg: Message = {
        id: `err-${Date.now()}`,
        direction: 'outbound',
        body: '⚠️ Connection error. Is the API server running on port 3000?',
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

  const resetSession = () => {
    setConnected(false);
    setMessages([]);
    setActivePhone('');
  };

  // Phone entry screen
  if (!connected) {
    return (
      <div className="flex flex-col h-full bg-white rounded-2xl shadow-lg overflow-hidden border border-earth-100">
        <div
          className="px-5 py-4 text-white"
          style={{ background: 'linear-gradient(135deg, #1a3409, #2d5016 40%, #4a7c28)' }}
        >
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-white/[0.13] flex items-center justify-center">
              <Icon name="msg" size={18} />
            </div>
            <div>
              <div className="font-bold text-[15px]">FarmLink Live Chat</div>
              <div className="text-white/50 text-[10px] tracking-wider uppercase">Direct to AI — No Twilio</div>
            </div>
          </div>
        </div>

        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center max-w-[300px]">
            <div className="w-16 h-16 rounded-2xl bg-farm-50 flex items-center justify-center mx-auto mb-4">
              <Icon name="msg" size={28} />
            </div>
            <h3 className="font-display font-bold text-earth-900 text-lg mb-2">Start a Conversation</h3>
            <p className="text-earth-500 text-sm mb-5 leading-relaxed">
              Enter a phone number to simulate an SMS session. Use an existing user&apos;s number or a new one to test signup.
            </p>

            <div className="mb-3">
              <input
                type="text"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && startSession()}
                placeholder="+15016266100 or 5016266100"
                className="w-full px-4 py-3 border border-earth-200 rounded-xl text-sm focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100"
              />
            </div>

            <button
              onClick={startSession}
              disabled={!phone.trim()}
              className="w-full py-3 bg-farm-600 text-white rounded-xl font-semibold text-sm hover:bg-farm-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              Connect
            </button>

            <div className="mt-5 text-left">
              <div className="text-[10px] text-earth-400 font-semibold uppercase tracking-wide mb-2">Seeded test numbers</div>
              {[
                { label: 'Sarah (Green Acres)', phone: '+15015550201' },
                { label: 'Jake (Riverside)', phone: '+15015550202' },
                { label: 'Maria (Ozark)', phone: '+15015550203' },
                { label: 'ABC Market', phone: '+15015550101' },
                { label: 'River Market', phone: '+15015550102' },
                { label: 'Hillcrest Co-op', phone: '+15015550103' },
                { label: 'New user (signup test)', phone: '+15559999999' },
              ].map((u) => (
                <button
                  key={u.phone}
                  onClick={() => { setPhone(u.phone); }}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-earth-15 rounded-lg transition-colors cursor-pointer"
                >
                  <span className="font-medium text-earth-700">{u.label}</span>
                  <span className="text-earth-400 ml-2">{u.phone}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Chat interface
  return (
    <div className="flex flex-col h-full bg-white rounded-2xl shadow-lg overflow-hidden border border-earth-100">
      {/* Header */}
      <div
        className="px-5 py-3 text-white flex items-center justify-between"
        style={{ background: 'linear-gradient(135deg, #1a3409, #2d5016 40%, #4a7c28)' }}
      >
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-white/[0.13] flex items-center justify-center">
            <Icon name="msg" size={18} />
          </div>
          <div>
            <div className="font-bold text-[14px]">FarmLink Live</div>
            <div className="text-white/60 text-[11px] font-mono">{activePhone}</div>
          </div>
        </div>
        <button
          onClick={resetSession}
          className="text-white/60 hover:text-white text-xs font-medium bg-white/10 px-3 py-1.5 rounded-lg cursor-pointer transition-colors"
        >
          Switch User
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3" style={{ background: '#f7f5f0' }}>
        {messages.length === 0 && !sending && (
          <div className="text-center text-earth-400 text-sm py-10">
            Send a message to start the conversation.
            {activePhone === '+15559999999' && (
              <div className="mt-2 text-xs text-farm-600 font-medium">
                This is an unregistered number — try signing up!
              </div>
            )}
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.direction === 'inbound' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] px-4 py-2.5 rounded-2xl text-[13.5px] leading-relaxed whitespace-pre-wrap ${
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
      <div className="border-t border-earth-100 p-3 flex gap-2 bg-white">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          disabled={sending}
          className="flex-1 px-4 py-2.5 border border-earth-200 rounded-xl text-sm focus:outline-none focus:border-farm-500 focus:ring-2 focus:ring-farm-100 disabled:opacity-50"
        />
        <button
          onClick={sendMessage}
          disabled={!input.trim() || sending}
          className="px-5 py-2.5 bg-farm-600 text-white rounded-xl font-semibold text-sm hover:bg-farm-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          Send
        </button>
      </div>
    </div>
  );
}
