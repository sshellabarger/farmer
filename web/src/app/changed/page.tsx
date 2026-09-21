import type { Metadata } from 'next';
import { TransitionNotice } from '@/components/transition-notice';

export const metadata: Metadata = {
  title: 'This page has moved — SJCA Market Manager',
};

/** Landing spot for the retired FarmLink v1 links that were texted to pilot
 *  users (/farmer, /market, /upload-photo, /signup). Hosting redirects those
 *  paths here so they never 404. */
export default function ChangedPage() {
  return <TransitionNotice title="This page has moved" />;
}
