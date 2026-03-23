'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Icon } from './icons';
import { api, type ConversationSummary, type ChatMessage } from '@/lib/api';

interface LiveSMSChatProps {
  roleFilter?: string; // 'farmer' | 'market' | undefined for all
  title: string;
  subtitle?: string;
}

function timeAgo(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

function formatTimestamp(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function LiveSMSChat({ roleFilter, title, subtitle }: LiveSMSChatProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showList, setShowList] = useState(true);
  const chatRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load conversations
  const loadConversations = useCallback(async () => {
    try {
      setError(null);
      const data = await api.getConversations(roleFilter);
      setConversations(data.conversations);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load conversations';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [roleFilter]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Load messages for selected conversation
  const loadMessages = useCallback(async (phone: string) => {
    setLoadingMessages(true);
    try {
      const data = await api.getChatHistory(phone);
      setMessages(data.messages);
    } catch {
      setMessages([]);
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  useEffect(() => {
    if (selectedPhone) {
      loadMessages(selectedPhone);
    }
  }, [selectedPhone, loadMessages]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages]);

  // Select a conversation
  const selectConversation = (phone: string) => {
    setSelectedPhone(phone);
    setShowList(false);
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  // Go back to list (mobile)
  const goBack = () => {
    setShowList(true);
    setSelectedPhone(null);
    setMessages([]);
  };

  // Send message
  const handleSend = async () => {
    if (!inputText.trim() || !selectedPhone || sending) return;
    const text = inputText.trim();
    setInputText('');
    setSending(true);

    // Optimistic: add the user message immediately
    const optimisticMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      conversation_id: '',
      direction: 'inbound',
      body: text,
      source: 'web',
      ai_metadata: null,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticMsg]);

    try {
      const result = await api.sendChat(selectedPhone, text);
      // Add the AI response
      const aiMsg: ChatMessage = {
        id: `temp-ai-${Date.now()}`,
        conversation_id: '',
        direction: 'outbound',
        body: result.response,
        source: 'web',
        ai_metadata: null,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, aiMsg]);
      // Refresh the conversation list for updated last_message
      loadConversations();
    } catch {
      // Show error as system message
      const errMsg: ChatMessage = {
        id: `temp-err-${Date.now()}`,
        conversation_id: '',
        direction: 'outbound',
        body: 'Failed to send message. Please try again.',
        source: 'web',
        ai_metadata: null,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errMsg]);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const selectedConv = conversations.find((c) => c.phone_number === selectedPhone);

  return (
    <div className="flex flex-col h-full bg-earth-25 rounded-[14px] overflow-hidden border border-earth-100">
      {/* Header */}
      <div
        className="flex items-center gap-2.5 shrink-0"
        style={{ background: 'linear-gradient(135deg, #2d5016 0%, #4a7c28 100%)', padding: '14px 18px' }}
      >
        {!showList && (
          <button
            onClick={goBack}
            className="sm:hidden w-8 h-8 rounded-full bg-white/[0.18] flex items-center justify-center text-white border-none cursor-pointer"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        )}
        <div className="w-[34px] h-[34px] rounded-full bg-white/[0.18] flex items-center justify-center text-white shrink-0">
          <Icon name="msg" size={17} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-white font-bold text-[13.5px] truncate">
            {selectedConv ? selectedConv.user_name : title}
          </div>
          <div className="text-white/65 text-[10.5px] truncate">
            {selectedConv ? selectedConv.phone_number : (subtitle || 'Live conversations')}
          </div>
        </div>
        {selectedPhone && (
          <button
            onClick={() => loadMessages(selectedPhone)}
            className="w-8 h-8 rounded-full bg-white/[0.18] flex items-center justify-center text-white border-none cursor-pointer"
            title="Refresh"
          >
            <Icon name="repeat" size={14} />
          </button>
        )}
      </div>

      {/* Body: split pane on desktop, toggle on mobile */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Conversation List */}
        <div
          className={`${
            showList ? 'flex' : 'hidden'
          } sm:flex flex-col border-r border-earth-100 overflow-hidden`}
          style={{ width: '100%', maxWidth: '100%' }}
        >
          <div className="sm:w-[260px] w-full flex flex-col h-full">
            <div className="p-2.5 border-b border-earth-100 bg-white">
              <div className="text-[10px] font-bold text-earth-500 uppercase tracking-wide">
                {conversations.length} conversation{conversations.length !== 1 ? 's' : ''}
              </div>
            </div>
            <div className="flex-1 overflow-auto">
              {loading && (
                <div className="p-6 text-center text-earth-400 text-xs">Loading conversations...</div>
              )}
              {error && (
                <div className="p-4 text-center">
                  <div className="text-red-500 text-xs mb-2">{error}</div>
                  <button
                    onClick={loadConversations}
                    className="text-xs text-farm-700 font-semibold border border-farm-200 rounded-md px-3 py-1 bg-white cursor-pointer"
                  >
                    Retry
                  </button>
                </div>
              )}
              {!loading && !error && conversations.length === 0 && (
                <div className="p-6 text-center text-earth-400 text-xs">
                  No conversations yet. Send a message to start one.
                </div>
              )}
              {conversations.map((conv) => (
                <button
                  key={conv.id}
                  onClick={() => selectConversation(conv.phone_number)}
                  className={`w-full text-left border-none cursor-pointer flex items-start gap-2.5 transition-colors ${
                    selectedPhone === conv.phone_number
                      ? 'bg-farm-50'
                      : 'bg-white hover:bg-earth-15'
                  }`}
                  style={{ padding: '12px 14px', borderBottom: '1px solid #f0ebe4' }}
                >
                  <div
                    className="w-[36px] h-[36px] rounded-full flex items-center justify-center text-white shrink-0 text-xs font-bold"
                    style={{
                      background: conv.user_role === 'farmer'
                        ? 'linear-gradient(135deg, #2d5016, #4a7c28)'
                        : 'linear-gradient(135deg, #1565c0, #1e88e5)',
                    }}
                  >
                    {conv.user_name
                      ? conv.user_name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()
                      : '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-baseline gap-2">
                      <span className="font-bold text-[12.5px] text-earth-900 truncate">
                        {conv.user_name || conv.phone_number}
                      </span>
                      <span className="text-[10px] text-earth-400 whitespace-nowrap shrink-0">
                        {timeAgo(conv.last_message_at)}
                      </span>
                    </div>
                    <div className="text-[11px] text-earth-500 truncate mt-0.5">
                      {conv.last_message_direction === 'outbound' && (
                        <span className="text-earth-400">AI: </span>
                      )}
                      {conv.last_message || 'No messages'}
                    </div>
                    <div className="flex gap-2 mt-1">
                      <span
                        className="text-[9px] font-semibold uppercase tracking-wide rounded-full px-1.5 py-0.5"
                        style={{
                          background: conv.user_role === 'farmer' ? '#e8f5e9' : '#e3f2fd',
                          color: conv.user_role === 'farmer' ? '#2e7d32' : '#1565c0',
                        }}
                      >
                        {conv.user_role}
                      </span>
                      <span className="text-[9px] text-earth-400">
                        {conv.message_count} msg{conv.message_count !== 1 ? 's' : ''}
                      </span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Chat Thread */}
        <div
          className={`${
            !showList ? 'flex' : 'hidden'
          } sm:flex flex-col flex-1 min-w-0`}
        >
          {!selectedPhone ? (
            <div className="flex-1 flex items-center justify-center p-8 text-center">
              <div>
                <div className="text-earth-300 mb-3">
                  <Icon name="msg" size={40} />
                </div>
                <div className="text-earth-500 text-sm font-medium">Select a conversation</div>
                <div className="text-earth-400 text-xs mt-1">Pick a conversation from the list to view messages</div>
              </div>
            </div>
          ) : (
            <>
              {/* Messages */}
              <div ref={chatRef} className="flex-1 overflow-auto p-3.5 flex flex-col gap-1.5">
                {loadingMessages && (
                  <div className="text-center py-8 text-earth-400 text-xs">Loading messages...</div>
                )}
                {!loadingMessages && messages.length === 0 && (
                  <div className="text-center py-8 text-earth-400 text-xs">
                    No messages yet. Send a message below.
                  </div>
                )}
                {messages.map((msg) => {
                  const isUser = msg.direction === 'inbound';
                  return (
                    <div key={msg.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                      <div className="max-w-[82%] flex flex-col">
                        <div
                          className="text-[13px] leading-relaxed whitespace-pre-line"
                          style={{
                            padding: '9px 13px',
                            borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                            background: isUser
                              ? 'linear-gradient(135deg, #2d5016, #4a7c28)'
                              : '#fff',
                            color: isUser ? '#fff' : '#2c2416',
                            boxShadow: isUser ? 'none' : '0 1px 2px rgba(0,0,0,0.06)',
                          }}
                        >
                          {msg.body}
                        </div>
                        <div
                          className={`text-[9px] text-earth-400 mt-0.5 ${
                            isUser ? 'text-right' : 'text-left'
                          }`}
                        >
                          {formatTimestamp(msg.created_at)}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {sending && (
                  <div className="flex">
                    <div className="bg-white rounded-[16px_16px_16px_4px] shadow-sm flex gap-1" style={{ padding: '10px 16px' }}>
                      {[0, 1, 2].map((i) => (
                        <div
                          key={i}
                          className="w-1.5 h-1.5 rounded-full bg-earth-500"
                          style={{ animation: `bounce 1.2s infinite ${i * 0.15}s` }}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Input */}
              <div className="p-2.5 bg-white border-t border-earth-100 shrink-0">
                <div className="flex gap-2 items-center">
                  <input
                    ref={inputRef}
                    type="text"
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Type a message..."
                    disabled={sending}
                    className="flex-1 rounded-full border border-earth-200 text-[13px] text-earth-900 font-sans outline-none focus:border-farm-400 transition-colors disabled:opacity-50"
                    style={{ padding: '9px 16px' }}
                  />
                  <button
                    onClick={handleSend}
                    disabled={!inputText.trim() || sending}
                    className="w-9 h-9 rounded-full border-none flex items-center justify-center cursor-pointer transition-opacity disabled:opacity-30 shrink-0"
                    style={{ background: 'linear-gradient(135deg, #2d5016, #4a7c28)' }}
                  >
                    <Icon name="send" size={15} />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* New conversation button */}
      {showList && (
        <NewConversationBar
          onStart={(phone) => {
            selectConversation(phone);
          }}
        />
      )}
    </div>
  );
}

function NewConversationBar({ onStart }: { onStart: (phone: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [phone, setPhone] = useState('');

  const handleStart = () => {
    if (phone.trim().length >= 10) {
      onStart(phone.trim());
      setPhone('');
      setExpanded(false);
    }
  };

  if (!expanded) {
    return (
      <div className="p-2.5 bg-white border-t border-earth-100 shrink-0">
        <button
          onClick={() => setExpanded(true)}
          className="w-full rounded-full border border-dashed border-earth-300 text-xs font-semibold text-earth-500 cursor-pointer bg-transparent font-sans transition-colors hover:border-farm-400 hover:text-farm-700"
          style={{ padding: '9px 14px' }}
        >
          + New Conversation
        </button>
      </div>
    );
  }

  return (
    <div className="p-2.5 bg-white border-t border-earth-100 shrink-0">
      <div className="flex gap-2 items-center">
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleStart()}
          placeholder="Phone number (e.g. +15015550201)"
          className="flex-1 rounded-full border border-earth-200 text-[13px] text-earth-900 font-sans outline-none focus:border-farm-400 transition-colors"
          style={{ padding: '9px 16px' }}
          autoFocus
        />
        <button
          onClick={handleStart}
          disabled={phone.trim().length < 10}
          className="rounded-full border-none text-white text-xs font-semibold font-sans cursor-pointer disabled:opacity-30"
          style={{ background: 'linear-gradient(135deg, #2d5016, #4a7c28)', padding: '9px 16px' }}
        >
          Start
        </button>
        <button
          onClick={() => { setExpanded(false); setPhone(''); }}
          className="w-8 h-8 rounded-full border border-earth-200 flex items-center justify-center cursor-pointer bg-white text-earth-500 shrink-0"
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    </div>
  );
}
