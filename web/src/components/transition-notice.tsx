import Link from 'next/link';
import { Header } from './header';
import { SiteFooter } from './site-footer';
import { Icon } from './icons';

const LEAD = 'FarmLink is becoming the St. Joseph Center of Arkansas farmers market manager.';

/** Interim page shown while FarmLink v1 is retired and the SJCA farmers
 *  market manager is built. Used by / and by /changed (the landing spot for
 *  the retired texted links: /farmer, /market, /upload-photo, /signup).
 *  Without `title`, the lead sentence is the headline. */
export function TransitionNotice({ title, children }: { title?: string; children?: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg font-sans flex flex-col">
      <Header />
      <main className="flex-1 px-4 md:px-6 lg:px-10 py-14 md:py-24">
        <div className="max-w-[640px] mx-auto" style={{ animation: 'fadeUp 0.6s ease both' }}>
          <div className="kicker mb-4">St. Joseph Center of Arkansas</div>
          <h1 className="h-display mb-5" style={{ fontSize: 'clamp(30px, 5vw, 44px)' }}>{title ?? LEAD}</h1>
          {title && (
            <p className="text-[17px] md:text-[19px] leading-relaxed text-text mb-5">{LEAD}</p>
          )}
          <p className="text-[15px] md:text-base leading-relaxed text-text-soft mb-8">
            If you sold through FarmLink, you&apos;ll get a text when the new weekly check-in system is ready.
          </p>
          <Link
            href="/login"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-full no-underline text-white font-bold text-[15px] transition-opacity hover:opacity-90"
            style={{ background: 'linear-gradient(135deg, #21512C 0%, #3D7A47 100%)', boxShadow: '0 4px 18px rgba(42,94,51,0.32)' }}
          >
            Market staff: log in <Icon name="arrow" size={16} />
          </Link>
          {children}
          <div className="mt-12 pt-6 border-t border-border-light flex items-center gap-3">
            <img src="/SJCA_logo_transparent.png" alt="St. Joseph Center of Arkansas" className="h-10 w-auto" />
            <p className="text-[13px] text-text-muted leading-snug m-0">
              A program of the <strong className="text-text-soft font-semibold">St. Joseph Center of Arkansas</strong>, a nonprofit.
            </p>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
