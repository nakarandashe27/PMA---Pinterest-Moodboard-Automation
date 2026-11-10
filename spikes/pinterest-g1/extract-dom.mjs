// Run with page.evaluate(extractPinCards) on an inspected Pinterest page.
// Reads rendered DOM only: no cookies, hidden app state or internal API.
export function extractPinCards() {
  const main = document.querySelector('[role="main"]') || document.querySelector('main');
  return {
    pageUrl: location.href,
    query: document.querySelector('[role="combobox"]')?.value ?? null,
    observedAt: new Date().toISOString(),
    candidates: main ? Array.from(main.querySelectorAll('a[href]')).map(a => {
      const url = new URL(a.href, location.href);
      const match = url.pathname.match(/^\/pin\/([1-9]\d*)\/?$/);
      const img = a.querySelector('img');
      return match && img ? {
        pinId: match[1],
        pinUrl: url.origin + '/pin/' + match[1] + '/',
        imageUrl: img.currentSrc || img.src,
        alt: img.alt,
        width: img.naturalWidth,
        height: img.naturalHeight
      } : null;
    }).filter(Boolean) : []
  };
}
