// Returns true when url is a SofaScore image — these need referrerPolicy="no-referrer"
// because SofaScore blocks requests with a non-sofascore.com Referer header.
export function isSofaScorePhoto(url: string | null | undefined): boolean {
  return !!url && url.includes("sofascore.com");
}
