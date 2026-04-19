'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { Icon } from './icons';
import { useRouter, usePathname } from 'next/navigation';

export function Header() {
  const { user, farm, market, isAuthenticated, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  const dashPath = user?.role === 'market' && !farm ? '/market' : '/farmer';

  return (
    <div
      className="sticky top-0 z-50 border-b border-border-light"
      style={{ background: 'rgba(250,248,245,0.92)', backdropFilter: 'blur(16px)' }}
    >
      <div className="max-w-[1140px] mx-auto px-4 sm:px-6 py-3 sm:py-3.5 flex items-center justify-between">
        {/* Logo */}
        <button
          onClick={() => router.push('/')}
          className="flex items-center gap-2 sm:gap-2.5 bg-transparent border-none cursor-pointer"
        >
          <div className="w-8 h-8 sm:w-[34px] sm:h-[34px] rounded-[10px] flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, #2E6B34 0%, #4A9B56 100%)' }}>
            <Icon name="leaf" size={18} className="text-white" />
          </div>
          <span className="font-display font-bold text-lg sm:text-xl text-text tracking-tight">
            FarmLink
          </span>
        </button>

        {/* Desktop Nav */}
        <div className="hidden md:flex items-center gap-1">
          <NavBtn active={pathname === '/'} onClick={() => router.push('/')}>
            Overview
          </NavBtn>
          {!isAuthenticated && (
            <NavBtn active={pathname === '/chat'} onClick={() => router.push('/chat')}>
              Live Chat
            </NavBtn>
          )}

          {isAuthenticated ? (
            <>
              <NavBtn active={pathname.startsWith(dashPath)} onClick={() => router.push(dashPath)}>
                {farm?.name || market?.name || 'Dashboard'}
              </NavBtn>
              {user?.role === 'both' && farm && market && (
                <NavBtn
                  active={pathname === '/market'}
                  onClick={() => router.push('/market')}
                >
                  {market.name}
                </NavBtn>
              )}
              <NavBtn active={pathname === '/feedback'} onClick={() => router.push('/feedback')}>
                Feedback
              </NavBtn>
              <NavBtn active={pathname === '/settings'} onClick={() => router.push('/settings')}>
                Settings
              </NavBtn>
              <NavBtn active={false} onClick={() => { logout(); router.push('/'); }}>
                Logout
              </NavBtn>
            </>
          ) : (
            <NavBtn active={pathname === '/login'} onClick={() => router.push('/login')}>
              Login
            </NavBtn>
          )}
        </div>

        {/* Mobile Hamburger */}
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="md:hidden flex items-center justify-center w-9 h-9 rounded-lg border border-border bg-white cursor-pointer text-text-soft"
          aria-label="Toggle menu"
        >
          <span className="text-lg">{menuOpen ? '✕' : '☰'}</span>
        </button>
      </div>

      {/* Mobile Menu Dropdown */}
      {menuOpen && (
        <div className="md:hidden border-t border-border-light px-4 pb-3 flex flex-col gap-1">
          <MobileNavBtn active={pathname === '/'} onClick={() => { router.push('/'); setMenuOpen(false); }}>
            Overview
          </MobileNavBtn>
          {!isAuthenticated && (
            <MobileNavBtn active={pathname === '/chat'} onClick={() => { router.push('/chat'); setMenuOpen(false); }}>
              Live Chat
            </MobileNavBtn>
          )}
          {isAuthenticated ? (
            <>
              <MobileNavBtn active={pathname.startsWith(dashPath)} onClick={() => { router.push(dashPath); setMenuOpen(false); }}>
                {farm?.name || market?.name || 'Dashboard'}
              </MobileNavBtn>
              {user?.role === 'both' && farm && market && (
                <MobileNavBtn
                  active={pathname === '/market'}
                  onClick={() => { router.push('/market'); setMenuOpen(false); }}
                >
                  {market.name}
                </MobileNavBtn>
              )}
              <MobileNavBtn active={pathname === '/feedback'} onClick={() => { router.push('/feedback'); setMenuOpen(false); }}>
                Feedback
              </MobileNavBtn>
              <MobileNavBtn active={pathname === '/settings'} onClick={() => { router.push('/settings'); setMenuOpen(false); }}>
                Settings
              </MobileNavBtn>
              <MobileNavBtn active={false} onClick={() => { logout(); router.push('/'); setMenuOpen(false); }}>
                Logout
              </MobileNavBtn>
            </>
          ) : (
            <MobileNavBtn active={pathname === '/login'} onClick={() => { router.push('/login'); setMenuOpen(false); }}>
              Login
            </MobileNavBtn>
          )}
        </div>
      )}
    </div>
  );
}

function NavBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-lg text-xs font-semibold cursor-pointer font-sans transition-all border-none"
      style={{
        padding: '7px 14px',
        background: active ? '#E8F5E3' : 'transparent',
        color: active ? '#2E6B34' : '#5C5C5C',
      }}
    >
      {children}
    </button>
  );
}

function MobileNavBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="text-left text-sm font-semibold cursor-pointer font-sans rounded-lg border-none w-full"
      style={{
        padding: '10px 14px',
        background: active ? '#E8F5E3' : 'transparent',
        color: active ? '#2E6B34' : '#5C5C5C',
      }}
    >
      {children}
    </button>
  );
}
