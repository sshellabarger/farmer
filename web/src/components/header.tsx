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
      className="sticky top-0 z-50"
      style={{ background: 'linear-gradient(135deg, #1a3409, #2d5016 40%, #4a7c28)' }}
    >
      <div className="max-w-[1140px] mx-auto px-4 sm:px-6 py-3 sm:py-3.5 flex items-center justify-between">
        {/* Logo */}
        <button
          onClick={() => router.push('/')}
          className="flex items-center gap-2 sm:gap-2.5 bg-transparent border-none cursor-pointer"
        >
          <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-[9px] bg-white/[0.13] flex items-center justify-center text-white">
            <Icon name="leaf" size={18} />
          </div>
          <div>
            <div className="text-white text-[16px] sm:text-[19px] font-extrabold font-display tracking-tight">
              FarmLink
            </div>
            <div className="text-white/50 text-[8px] sm:text-[10px] tracking-widest uppercase hidden sm:block">
              Farm to Market · Text-First
            </div>
          </div>
        </button>

        {/* Desktop Nav */}
        <div className="hidden md:flex items-center gap-[3px]">
          <NavBtn active={pathname === '/'} onClick={() => router.push('/')}>
            Overview
          </NavBtn>
          {!isAuthenticated && (
            <NavBtn active={pathname === '/chat'} onClick={() => router.push('/chat')}>
              💬 Live Chat
            </NavBtn>
          )}

          {isAuthenticated ? (
            <>
              <NavBtn active={pathname.startsWith(dashPath)} onClick={() => router.push(dashPath)}>
                {user?.role === 'farmer' && '🌱 '}
                {user?.role === 'market' && '🏪 '}
                {user?.role === 'both' && '🌱 '}
                {farm?.name || market?.name || 'Dashboard'}
              </NavBtn>
              {user?.role === 'both' && farm && market && (
                <NavBtn
                  active={pathname === '/market'}
                  onClick={() => router.push('/market')}
                >
                  🏪 {market.name}
                </NavBtn>
              )}
              <NavBtn active={pathname === '/settings'} onClick={() => router.push('/settings')}>
                ⚙️ Settings
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
          className="md:hidden flex items-center justify-center w-9 h-9 rounded-lg bg-white/10 border-none cursor-pointer text-white"
          aria-label="Toggle menu"
        >
          <span className="text-lg">{menuOpen ? '✕' : '☰'}</span>
        </button>
      </div>

      {/* Mobile Menu Dropdown */}
      {menuOpen && (
        <div className="md:hidden border-t border-white/10 px-4 pb-3 flex flex-col gap-1">
          <MobileNavBtn active={pathname === '/'} onClick={() => { router.push('/'); setMenuOpen(false); }}>
            Overview
          </MobileNavBtn>
          {!isAuthenticated && (
            <MobileNavBtn active={pathname === '/chat'} onClick={() => { router.push('/chat'); setMenuOpen(false); }}>
              💬 Live Chat
            </MobileNavBtn>
          )}
          {isAuthenticated ? (
            <>
              <MobileNavBtn active={pathname.startsWith(dashPath)} onClick={() => { router.push(dashPath); setMenuOpen(false); }}>
                {user?.role === 'farmer' && '🌱 '}
                {user?.role === 'market' && '🏪 '}
                {user?.role === 'both' && '🌱 '}
                {farm?.name || market?.name || 'Dashboard'}
              </MobileNavBtn>
              {user?.role === 'both' && farm && market && (
                <MobileNavBtn
                  active={pathname === '/market'}
                  onClick={() => { router.push('/market'); setMenuOpen(false); }}
                >
                  🏪 {market.name}
                </MobileNavBtn>
              )}
              <MobileNavBtn active={pathname === '/settings'} onClick={() => { router.push('/settings'); setMenuOpen(false); }}>
                ⚙️ Settings
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
      className="text-white border rounded-[7px] text-[11.5px] font-semibold cursor-pointer font-sans transition-all"
      style={{
        padding: '6px 13px',
        background: active ? 'rgba(255,255,255,0.18)' : 'transparent',
        borderColor: active ? 'rgba(255,255,255,0.25)' : 'transparent',
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
      className="text-white text-left text-sm font-semibold cursor-pointer font-sans rounded-lg border-none w-full"
      style={{
        padding: '10px 14px',
        background: active ? 'rgba(255,255,255,0.15)' : 'transparent',
      }}
    >
      {children}
    </button>
  );
}
