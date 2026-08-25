// Rewrite SofaScore image URLs to go through our server proxy, which adds
// the Referer: sofascore.com header required to avoid hotlink blocking in prod.
// FPL and TheSportsDB URLs are returned unchanged.
export function proxyPhotoUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = url.match(/sofascore\.com\/api\/v1\/player\/(\d+)\/image/);
  if (match) return `/api/player-photo/${match[1]}`;
  return url;
}
