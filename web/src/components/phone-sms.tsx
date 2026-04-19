'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Icon } from './icons';

interface ScriptMessage {
  from: string;
  text: string;
}

interface PhoneSMSProps {
  script: ScriptMessage[];
  title: string;
  autoPlay?: boolean;
  compact?: boolean;
}

export function PhoneSMS({ script, title, autoPlay = false, compact = false }: PhoneSMSProps) {
  const [messages, setMessages] = useState<(ScriptMessage & { id: number })[]>([]);
  const [typing, setTyping] = useState(false);
  const [idx, setIdx] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const pushMessage = useCallback(() => {
    if (idx >= script.length) return;
    const msg = script[idx];
    if (msg.from === 'app') {
      setTyping(true);
      timerRef.current = setTimeout(() => {
        setTyping(false);
        setMessages(p => [...p, { ...msg, id: Date.now() }]);
        setIdx(i => i + 1);
      }, 800 + Math.random() * 600);
    } else {
      setMessages(p => [...p, { ...msg, id: Date.now() }]);
      setIdx(i => i + 1);
    }
  }, [idx, script]);

  useEffect(() => {
    if (autoPlay && idx < script.length) {
      const delay = idx === 0 ? 600 : (script[idx]?.from === 'app' ? 1800 : 1200);
      timerRef.current = setTimeout(pushMessage, delay);
    }
    return () => clearTimeout(timerRef.current);
  }, [idx, autoPlay, pushMessage, script]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, typing]);

  const reset = () => {
    setMessages([]);
    setIdx(0);
    setTyping(false);
    clearTimeout(timerRef.current);
  };

  return (
    <div className={`${compact ? 'w-[280px] h-[420px]' : 'w-[320px] h-[520px]'} bg-black rounded-[36px] p-[12px_10px] relative overflow-hidden`}
      style={{ boxShadow: '0 8px 40px rgba(0,0,0,0.08)' }}>
      {/* Notch */}
      <div className="absolute top-2 left-1/2 -translate-x-1/2 w-[100px] h-6 bg-black rounded-xl z-10" />
      {/* Screen */}
      <div className="w-full h-full bg-bg rounded-[28px] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="pt-8 pb-2.5 px-4 flex items-center gap-2.5" style={{ background: '#2E6B34' }}>
          <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center text-sm">🌱</div>
          <div>
            <div className="font-sans font-bold text-[13px] text-white">{title}</div>
            <div className="font-sans text-[10px] text-white/70">FarmLink Assistant</div>
          </div>
        </div>
        {/* Messages */}
        <div ref={scrollRef} className="flex-1 px-3 py-3 overflow-y-auto flex flex-col gap-1.5">
          {messages.map((msg) => {
            const isUser = msg.from === 'user';
            return (
              <div key={msg.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`} style={{ animation: 'msgIn 0.3s ease' }}>
                <div className={`max-w-[82%] px-3 py-2 font-sans font-normal whitespace-pre-line ${compact ? 'text-[11.5px]' : 'text-[12.5px]'}`}
                  style={{
                    borderRadius: isUser ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                    background: isUser ? '#2E6B34' : '#fff',
                    color: isUser ? '#fff' : '#1A1A1A',
                    lineHeight: 1.5,
                    boxShadow: isUser ? 'none' : '0 1px 2px rgba(0,0,0,0.05)',
                  }}>
                  {msg.text}
                </div>
              </div>
            );
          })}
          {typing && (
            <div className="flex" style={{ animation: 'fadeIn 0.2s ease' }}>
              <div className="bg-white px-4 py-2.5 rounded-[14px] flex gap-[5px] items-center" style={{ boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                {[0, 1, 2].map(i => (
                  <div key={i} className="w-1.5 h-1.5 rounded-full" style={{ background: '#2E6B34', animation: `typingDot 1.2s infinite ${i * 0.2}s` }} />
                ))}
              </div>
            </div>
          )}
        </div>
        {/* Input */}
        <div className="px-3 pb-3 pt-2 border-t border-border-light flex gap-2 items-center">
          <div className="flex-1 px-3 py-2 rounded-[20px] bg-white border border-border text-[11px] text-text-muted font-sans truncate">
            {idx < script.length && !autoPlay ? script[idx]?.text?.slice(0, 30) + '...' : 'Type a message...'}
          </div>
          {!autoPlay && idx < script.length ? (
            <button onClick={pushMessage} className="w-8 h-8 rounded-full border-none cursor-pointer flex items-center justify-center shrink-0" style={{ background: '#2E6B34' }}>
              <Icon name="send" size={14} className="text-white" />
            </button>
          ) : idx >= script.length ? (
            <button onClick={reset} className="px-3 py-1.5 rounded-2xl border-none cursor-pointer text-[10px] font-semibold font-sans" style={{ background: '#E8F5E3', color: '#2E6B34' }}>
              Replay
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
