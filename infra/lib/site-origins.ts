/**
 * Marketplace SPA origins for Cognito OAuth + CORS.
 *
 * Override with CDK context if a one-off origin is needed, e.g.:
 *   cdk deploy BuzzAuthStack -c siteOrigins=http://localhost:4321,https://buzzftw.com,https://www.buzzftw.com,https://folstad.ca
 *
 * Folstad marketing (folstad.ca) is a separate S3/CloudFront site — do not add it
 * to the default list. Community hosts (*.buzzftw.com) are on Hetzner, not this SPA.
 */
export const DEFAULT_SITE_ORIGINS =
  "http://localhost:4321,https://buzzftw.com,https://www.buzzftw.com";

export function parseSiteOrigins(raw: unknown): string[] {
  const value = typeof raw === "string" && raw.trim() ? raw : DEFAULT_SITE_ORIGINS;
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function originBase(origin: string): string {
  return origin.replace(/\/$/, "");
}
