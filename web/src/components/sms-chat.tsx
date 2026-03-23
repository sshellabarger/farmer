'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Icon } from './icons';
import { Btn } from './ui';

interface Message {
  from: string;
  text: string;
  delay?: number;
  id?: number;
}

interface SMSChatProps {
  script: Message[];
  userRole: string;
  title: string;
  subtitle?: string;
}

export function SMSChat({ script, userRole, title, subtitle }: SMSChatProps) {
  const [messages, setMessages] = useState<(Message & { id: number })[]>([]);
  const [scriptIdx, setScriptIdx] = useState(0);
  const [isTyping, setIsTyping] = useState(false);
  const [typingLabel, setTypingLabel] = useState('');
  const [autoPlay, setAutoPlay] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, isTyping]);

  useEffect(() => {
    if (!autoPlay || scriptIdx >= script.length) {
      setIsTyping(false);
      setTypingLabel('');
      return;
    }
    const msg = script[scriptIdx];
    const isUser = msg.from === userRole;

    // Show typing indicator for both user and AI messages
    setIsTyping(true);
    setTypingLabel(isUser ? title : 'FarmLink AI');

    // User messages: show typing for 1.2s then reveal
    // AI messages: show typing for (delay + 1000)ms then reveal
    const typingDuration = isUser ? 1200 : ((msg.delay || 800) + 1000);

    timerRef.current = setTimeout(() => {
      setIsTyping(false);
      setTypingLabel('');
      setMessages((prev) => [...prev, { ...msg, id: Date.now() }]);
      setScriptIdx((prev) => prev + 1);
    }, typingDuration);

    return () => clearTimeout(timerRef.current);
  }, [autoPlay, scriptIdx, script, userRole, title]);

  const pushNext = useCallback(() => {
    if (scriptIdx >= script.length) return;
    const msg = script[scriptIdx];
    setMessages((prev) => [...prev, { ...msg, id: Date.now() }]);
    setScriptIdx((prev) => prev + 1);
    const next = script[scriptIdx + 1];
    if (next && next.from !== script[scriptIdx]?.from) {
      setIsTyping(true);
      setTypingLabel(next.from === userRole ? title : 'FarmLink AI');
      setTimeout(() => {
        setIsTyping(false);
        setTypingLabel('');
        setMessages((prev) => [...prev, { ...next, id: Date.now() + 1 }]);
        setScriptIdx((prev) => prev + 2);
      }, next.delay || 800);
    }
  }, [scriptIdx, script, userRole, title]);

  const nextMsg = script[scriptIdx];
  const canSend = nextMsg && nextMsg.from === userRole;

  return (
    <div className="flex flex-col h-full bg-earth-25 rounded-[14px] overflow-hidden border border-earth-200">
      {/* Header */}
      <div
        className="flex items-center gap-2.5"
        style={{ background: 'linear-gradient(135deg, #2d5016 0%, #4a7c28 100%)', padding: '14px 18px' }}
      >
        <div className="w-[34px] h-[34px] rounded-full bg-white/[0.18] flex items-center justify-center text-white">
          <Icon name="leaf" size={17} />
        </div>
        <div className="flex-1">
          <div className="text-white font-bold text-[13.5px]">{title}</div>
          <div className="text-white/65 text-[10.5px]">{subtitle || 'FarmLink Smart Assistant'}</div>
        </div>
        {!autoPlay && messages.length === 0 && (
          <Btn onClick={() => setAutoPlay(true)} small style={{ background: 'rgba(255,255,255,0.18)', color: '#fff' }}>
            ▶ Auto
          </Btn>
        )}
      </div>

      {/* Messages */}
      <div ref={chatRef} className="flex-1 overflow-auto p-3.5 flex flex-col gap-1.5">
        {messages.length === 0 && !autoPlay && (
          <div className="text-center py-8 text-earth-500 text-[12.5px]">
            Click &quot;Auto&quot; to watch the conversation, or step through manually below
          </div>
        )}
        {messages.map((msg) => {
          const isUser = msg.from === userRole;
          return (
            <div key={msg.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`} style={{ animation: 'fadeSlide 0.25s ease' }}>
              <div
                className="max-w-[82%] text-[13px] leading-relaxed whitespace-pre-line"
                style={{
                  padding: '9px 13px',
                  borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                  background: isUser ? 'linear-gradient(135deg, #2d5016, #4a7c28)' : '#fff',
                  color: isUser ? '#fff' : '#2c2416',
                  boxShadow: isUser ? 'none' : '0 1px 2px rgba(0,0,0,0.06)',
                }}
              >
                {msg.text}
              </div>
            </div>
          );
        })}
        {isTyping && (
          <div className="flex flex-col gap-0.5">
            <div className="text-[9px] text-earth-400 font-semibold ml-1">{typingLabel} is typing...</div>
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
          </div>
        )}
      </div>

      {/* Input area */}
      {!autoPlay && scriptIdx < script.length && (
        <div className="p-2.5 bg-white border-t border-earth-100">
          <button
            onClick={pushNext}
            className="w-full rounded-full border-none text-xs font-semibold font-sans"
            style={{
              padding: '9px 14px',
              background: canSend ? 'linear-gradient(135deg, #2d5016, #4a7c28)' : '#e8e0d6',
              color: canSend ? '#fff' : '#8a7e72',
              cursor: canSend ? 'pointer' : 'default',
            }}
          >
            {canSend
              ? `Send: "${nextMsg.text.slice(0, 50)}${nextMsg.text.length > 50 ? '...' : ''}"`
              : 'Waiting for response...'}
          </button>
        </div>
      )}
      {(autoPlay || scriptIdx >= script.length) && scriptIdx >= script.length && (
        <div className="p-2.5 bg-white border-t border-earth-100 text-center text-xs text-earth-500">
          ✅ Demo complete
        </div>
      )}
    </div>
  );
}
