import { Icon } from './icons';
import { FARMLINK_NUMBER_DISPLAY, smsHref } from '@/lib/constants';

/** Site-wide footer. The Privacy and Terms links point at the static legal
 *  pages in web/public, which are rewritten separately (SPEC §1.5(8), D18). */
export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-bg-alt">
      <div className="max-w-[1020px] mx-auto px-4 md:px-6 lg:px-10 py-10 md:py-12">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 mb-8">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #21512C 0%, #3D7A47 100%)' }}>
                <Icon name="leaf" size={14} className="text-white" />
              </div>
              <span className="font-display font-semibold text-[17px] text-text">FarmLink</span>
            </div>
            <p className="text-[13px] text-text-muted leading-relaxed m-0">
              Becoming the farmers market manager for the St. Joseph Center of Arkansas, a nonprofit.
            </p>
          </div>
          <div>
            <div className="font-semibold text-[13px] text-text mb-3 uppercase tracking-wide">Market staff</div>
            <div className="flex flex-col gap-2">
              <a href="/login" className="text-[13.5px] text-text-soft no-underline hover:text-text">Log in</a>
            </div>
          </div>
          <div>
            <div className="font-semibold text-[13px] text-text mb-3 uppercase tracking-wide">Reach us</div>
            <div className="flex flex-col gap-2">
              <a href={smsHref()} className="text-[13.5px] font-semibold text-green-700 no-underline">📱 Text {FARMLINK_NUMBER_DISPLAY}</a>
            </div>
          </div>
        </div>
        <div className="pt-6 border-t border-border flex flex-col sm:flex-row justify-between items-center gap-3">
          <div className="text-[12.5px] text-text-muted">&copy; 2026 FarmLink · St. Joseph Center of Arkansas</div>
          <div className="flex gap-5">
            <a href="/privacy.html" className="text-[12.5px] text-text-muted no-underline hover:text-text-soft">Privacy</a>
            <a href="/terms.html" className="text-[12.5px] text-text-muted no-underline hover:text-text-soft">Terms</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
