// ARIA states need an explicit "true"/"false"; other booleans are present/absent attributes.
export const attrValue = (k: string, v: unknown): string | null => {
  if (v === null || v === undefined || typeof v === "function") return null;
  if (typeof v === "boolean") return k.startsWith("aria-") ? String(v) : v ? "" : null;
  return String(v);
};
