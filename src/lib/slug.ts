/** Lowercase, hyphenate, strip non-alphanumeric. Empty → fallback. */
export function slugify(input: string, fallback = "project"): string {
  const slug = input
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 48)
    .replace(/-+$/g, "");

  return slug || fallback;
}
