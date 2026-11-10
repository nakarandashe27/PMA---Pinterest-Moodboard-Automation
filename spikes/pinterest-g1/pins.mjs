// G1 evidence normalization only; this is not relevance/CV ranking.
export function normalizePin(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid candidate');
  const pin = new URL(raw.pinUrl);
  const media = new URL(raw.imageUrl);
  const match = pin.pathname.match(/^\/pin\/([1-9]\d*)\/?$/);
  const pinterestHost = pin.hostname === 'pinterest.com' || pin.hostname.endsWith('.pinterest.com');
  if (pin.protocol !== 'https:' || !pinterestHost || pin.username || pin.password || pin.port || !match) {
    throw new Error('Invalid Pinterest source');
  }
  if (typeof raw.pinId !== 'string' || raw.pinId !== match[1]) throw new Error('Pin ID mismatch');
  if (media.protocol !== 'https:' || media.hostname !== 'i.pinimg.com' || media.username || media.password || media.port) {
    throw new Error('Invalid Pinterest image');
  }
  return {
    pinId: match[1],
    pinUrl: 'https://www.pinterest.com/pin/' + match[1] + '/',
    imageUrl: media.href,
    altText: typeof raw.alt === 'string' ? raw.alt.slice(0, 1000) : '',
    observedWidth: Number.isFinite(raw.width) && raw.width > 0 ? raw.width : null,
    observedHeight: Number.isFinite(raw.height) && raw.height > 0 ? raw.height : null
  };
}
export function normalizeCandidates(rawCandidates) {
  if (!Array.isArray(rawCandidates)) throw new Error('Candidates must be an array');
  const unique = new Map();
  const rejected = [];
  for (const [index, raw] of rawCandidates.entries()) {
    try {
      const pin = normalizePin(raw);
      if (!unique.has(pin.pinId)) unique.set(pin.pinId, pin);
    } catch (error) {
      rejected.push({ index, reason: error.message });
    }
  }
  return { pins: [...unique.values()], rejected };
}

export function verifySinglePinSave(sourceRaw, boardCandidates) {
  const source = normalizePin(sourceRaw);
  const { pins, rejected } = normalizeCandidates(boardCandidates);
  if (rejected.length || pins.length !== 1) throw new Error('Ambiguous board readback');
  const imageKey = url => new URL(url).pathname.match(/\/([a-f0-9]{32})\.(?:jpe?g|png|webp)$/i)?.[1]?.toLowerCase();
  const sourceKey = imageKey(source.imageUrl);
  if (!sourceKey || sourceKey !== imageKey(pins[0].imageUrl)) throw new Error('Saved image differs');
  return { sourcePinId: source.pinId, savedPinId: pins[0].pinId,
    sourcePinUrl: source.pinUrl, savedPinUrl: pins[0].pinUrl, pinterestImageKey: sourceKey };
}
