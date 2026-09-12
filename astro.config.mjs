// @ts-check
import { defineConfig } from "astro/config";

// Optional subpath builds. Marketing / GitHub Pages is not published from this repo.
const base = process.env.BASE_PATH
  ? `/${process.env.BASE_PATH.replace(/^\/|\/$/g, "")}/`
  : "/";

// https://astro.build/config
export default defineConfig({
  site: process.env.SITE_URL || "https://buzzftw.com",
  base,
  output: "static",
  trailingSlash: "ignore",
});
