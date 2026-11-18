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
// in its own order.
//
// It never passes a shape it does not recognise through as it is, and it never
// throws: both callers are fail-soft (a build keeps its snapshot and exits 0), and
// a throw here would stop the build, not protect it. So the key is dropped from
// the registry itself, and from every row whether `households` is a map of rows
// (the office's shape) or an array of them, and a row that is not an object (it
// can carry no key) is left as it is.
export const PRIVATE_HOUSE_KEYS = Object.freeze(["human"]);

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const dropPrivate = (v) => (isObject(v) ? Object.fromEntries(Object.entries(v).filter(([key]) => !PRIVATE_HOUSE_KEYS.includes(key))) : v);

export function publicRegistry(registry) {
  if (!isObject(registry)) return registry;
  const out = dropPrivate(registry);
  const rows = out.households;
  if (Array.isArray(rows)) out.households = rows.map(dropPrivate);
  else if (isObject(rows)) out.households = Object.fromEntries(Object.entries(rows).map(([slug, row]) => [slug, dropPrivate(row)]));
  return out;
}
