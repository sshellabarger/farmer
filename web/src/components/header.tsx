'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { Icon } from './icons';
import { useRouter, usePathname } from 'next/navigation';
import { FARMLINK_NUMBER_DISPLAY, smsHref } from '@/lib/constants';

interface NavItem {
  label: string;
  href: string;
  active?: boolean;
}

export function Header() {
  const { isAuthenticated, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  const navItems: NavItem[] = isAuthenticated
    ? [
        { label: 'Admin', href: '/admin', active: pathname === '/admin' },
        { label: 'Feedback', href: '/feedback', active: pathname === '/feedback' },
        { label: 'Settings', href: '/settings', active: pathname === '/settings' },
      ]
    : [];

  const go = (href: string) => {
    setMenuOpen(false);
    router.push(href);
  };

  const signOut = () => {
    logout();
    setMenuOpen(false);
    router.push('/');
  };

  return (
    <div
      className="sticky top-0 z-50 border-b border-border-light"
      style={{ background: 'rgba(250,248,244,0.9)', backdropFilter: 'blur(14px)' }}
    >
      <div className="max-w-[1180px] mx-auto px-4 sm:px-6 h-[60px] flex items-center justify-between gap-3">
        {/* Wordmark */}
        <Link
          href={isAuthenticated ? '/admin' : '/'}
          className="flex items-center gap-2.5 no-underline shrink-0"
          aria-label="FarmLink home"
        >
          <div
            className="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, #21512C 0%, #3D7A47 100%)' }}
          >
            <Icon name="leaf" size={18} className="text-white" />
          </div>
          <span className="font-display font-semibold text-[20px] text-text tracking-tight">FarmLink</span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden lg:flex items-center gap-1" aria-label="Main">
          {navItems.map(item => (
            <button
              key={item.href + item.label}
              onClick={() => go(item.href)}
              className={`px-3.5 py-2 rounded-full font-sans font-semibold text-[13.5px] cursor-pointer border-none transition-colors ${
                item.active ? 'bg-green-50 text-green-700' : 'bg-transparent text-text-soft hover:text-text'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {/* Desktop actions */}
        <div className="hidden lg:flex items-center gap-2.5 shrink-0">
          <a
            href={smsHref('Hi FarmLink!')}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-full no-underline font-sans font-semibold text-[13px] text-green-700 border border-green-100 bg-green-50/60 hover:bg-green-50 transition-colors"
          >
            <Icon name="msg" size={14} />
            Text {FARMLINK_NUMBER_DISPLAY}
          </a>
          {isAuthenticated ? (
            <button
              onClick={signOut}
              className="px-3.5 py-2 rounded-full font-sans font-semibold text-[13.5px] cursor-pointer border border-border bg-transparent text-text-soft hover:text-text transition-colors"
            >
              Log out
            </button>
          ) : (
            <button
              onClick={() => go('/login')}
              className="px-3.5 py-2 rounded-full font-sans font-semibold text-[13.5px] cursor-pointer border border-border bg-transparent text-text-soft hover:text-text transition-colors"
            >
              Log in
            </button>
          )}
        </div>

        {/* Mobile hamburger */}
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="lg:hidden flex items-center justify-center w-10 h-10 rounded-xl border border-border bg-white cursor-pointer text-text-soft"
          aria-label="Toggle menu"
          aria-expanded={menuOpen}
        >
          <span className="text-lg leading-none">{menuOpen ? '✕' : '☰'}</span>
        </button>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="lg:hidden border-t border-border-light px-4 pt-2 pb-4 flex flex-col gap-1 bg-bg" style={{ animation: 'fadeIn 0.15s ease' }}>
          {navItems.map(item => (
            <button
              key={item.href + item.label}
              onClick={() => go(item.href)}
              className={`text-left font-sans font-semibold text-[15px] rounded-xl border-none w-full cursor-pointer px-4 py-3 ${
                item.active ? 'bg-green-50 text-green-700' : 'bg-transparent text-text-soft'
              }`}
            >
              {item.label}
            </button>
          ))}
          {isAuthenticated ? (
            <button
              onClick={signOut}
              className="text-left font-sans font-semibold text-[15px] rounded-xl border-none w-full cursor-pointer px-4 py-3 bg-transparent text-text-soft"
            >
              Log out
            </button>
          ) : (
            <button
              onClick={() => go('/login')}
              className="text-left font-sans font-semibold text-[15px] rounded-xl border-none w-full cursor-pointer px-4 py-3 bg-transparent text-text-soft"
            >
              Log in
            </button>
          )}
          <a
            href={smsHref('Hi FarmLink!')}
            className="flex items-center justify-center gap-2 mt-1 px-4 py-3 rounded-xl no-underline font-sans font-semibold text-[15px] text-green-700 border border-green-100 bg-green-50/60"
          >
            <Icon name="msg" size={16} />
            Text us · {FARMLINK_NUMBER_DISPLAY}
          </a>
        </div>
      )}
    </div>
  );
}
