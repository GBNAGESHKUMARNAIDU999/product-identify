/** @type {import('next').NextConfig} */
const nextConfig = {
  // Route-level redirect: a prerendered `redirect()` page served by
  // `next start` emits a 307 without a Location header, so `/` is
  // redirected here at the routing layer instead.
  async redirects() {
    return [{ source: "/", destination: "/inventories", permanent: false }];
  },
};

export default nextConfig;
