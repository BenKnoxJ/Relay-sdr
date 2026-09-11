/**
 * The bench is compiled out of a production build.
 *
 * Its pages are named `page.dev.tsx`, and that suffix only counts as a page
 * extension when `NODE_ENV` is `development`. So `next build` does not see a
 * route at `/bench` at all — there is nothing to serve, nothing to guard and
 * nothing to get wrong at run time. `src/lib/bench/devOnly.ts` is the second
 * gate, for the case this one cannot cover: a build made with
 * `NODE_ENV=development` and then served.
 *
 * The default list is Next's own (`tsx`, `ts`, `jsx`, `js`, `mdx`). It has to
 * be written out, because supplying `pageExtensions` replaces it rather than
 * adding to it.
 */
const PAGE_EXTENSIONS = ["tsx", "ts", "jsx", "js"];

/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  pageExtensions:
    process.env.NODE_ENV === "development"
      ? ["dev.tsx", "dev.ts", ...PAGE_EXTENSIONS]
      : PAGE_EXTENSIONS,
};

export default nextConfig;
