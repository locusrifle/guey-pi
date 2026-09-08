// Two product compositions share one server. Stock is the ready-to-run Pi GUI.
// locusrifle is Noah's overlay. Unset GUEY_PRODUCT keeps today's live unit
// (LOCUS_SITE_HOST) personal; desktop sets stock explicitly.

export function resolveProduct(options = {}) {
  const raw = options.product ?? process.env.GUEY_PRODUCT;
  if (raw === 'stock' || raw === 'guey') return 'stock';
  if (raw === 'locusrifle') return 'locusrifle';
  if (process.env.LOCUS_SITE_HOST) return 'locusrifle';
  return options.defaultProduct ?? 'locusrifle';
}

export const PERSONAL_CONTROL_IDS = new Set([
  'capture', 'desktop-open', 'desktop-close', 'push-subscribe',
]);
