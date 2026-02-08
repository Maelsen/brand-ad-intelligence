/**
 * Shared constants across the project
 */

/** Domains that belong to Meta/Facebook platforms — filter these from ad landing page results */
export const PLATFORM_DOMAINS = [
  'facebook.com',
  'fb.com',
  'fbcdn.net',
  'instagram.com',
  'meta.com',
  'meta.ai',
  'facebook.net',
  'threads.net',
  'whatsapp.com',
  'messenger.com',
  'fb.me',
  'l.facebook.com',
  'l.instagram.com',
];

/**
 * Check if a URL belongs to a platform domain (should be filtered out)
 */
export function isPlatformDomain(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return PLATFORM_DOMAINS.some(d => h === d || h.endsWith(`.${d}`));
}

/**
 * Check if a URL is a valid external landing page (not a platform URL)
 */
export function isValidExternalUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (!parsed.hostname.includes('.')) return false;
    return !isPlatformDomain(parsed.hostname);
  } catch {
    return false;
  }
}
