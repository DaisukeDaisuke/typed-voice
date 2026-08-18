export const PAIRING_SCAN_MAX_SOURCE_PIXELS = 1600;

export function resolvePairingScanRect(sourceWidth, sourceHeight, maxPixels = PAIRING_SCAN_MAX_SOURCE_PIXELS) {
  const width = Math.max(0, Math.floor(Number(sourceWidth) || 0));
  const height = Math.max(0, Math.floor(Number(sourceHeight) || 0));
  const limit = Math.max(1, Math.floor(Number(maxPixels) || PAIRING_SCAN_MAX_SOURCE_PIXELS));
  const scanWidth = Math.min(width, limit);
  const scanHeight = Math.min(height, limit);
  return Object.freeze({
    x: Math.max(0, Math.floor((width - scanWidth) / 2)),
    y: Math.max(0, Math.floor((height - scanHeight) / 2)),
    width: scanWidth,
    height: scanHeight,
  });
}
