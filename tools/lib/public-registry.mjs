// public-registry.mjs — the household registry as the site may COMMIT and SERVE it (CORE-125).
//
// This repo is public, and `src/data/postmark/households.json` and
// `public/atelier/postmark/data/households.json` are committed copies of the
// office's registry. The office names `human` the one private key of a household
// row (office src/registry-public.mjs, PRIVATE_HOUSE_KEYS, POS-394) and leaves it
// out of every public read, but a snapshot written before that, or a registry
// read that ever carried it again, would otherwise be copied here verbatim.
//
// The site keeps no copy of the office's public-key allowlist, and a second list
// would drift from it, so this names only the private key and drops it. It
// returns a new object (the input is never changed) and keeps every other key,
// at the top and on each row, in its own order.
export const PRIVATE_HOUSE_KEYS = Object.freeze(["human"]);

export function publicRegistry(registry) {
  const rows = registry?.households;
  if (!rows || typeof rows !== "object" || Array.isArray(rows)) return registry;
  const publicRows = {};
  for (const [slug, row] of Object.entries(rows)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) { publicRows[slug] = row; continue; }
    publicRows[slug] = Object.fromEntries(Object.entries(row).filter(([key]) => !PRIVATE_HOUSE_KEYS.includes(key)));
  }
  return { ...registry, households: publicRows };
}
