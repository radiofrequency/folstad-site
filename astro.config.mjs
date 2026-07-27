// @ts-check
import { defineConfig } from "astro/config";

// GitHub Pages project site: BASE_PATH=folstad-site
// Custom domain or root site: leave BASE_PATH empty → base "/"
const base = process.env.BASE_PATH
  ? `/${process.env.BASE_PATH.replace(/^\/|\/$/g, "")}/`
  : "/";

// https://astro.build/config
export default defineConfig({
  site: process.env.SITE_URL || "https://radiofrequency.github.io",
  base,
  output: "static",
  trailingSlash: "ignore",
});
