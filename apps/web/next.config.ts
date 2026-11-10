import type { NextConfig } from 'next';
import path from 'path';

const API_URL = process.env.API_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  poweredByHeader: false,
  output: 'standalone',
  // Keep the production build within a small server's memory (it shares the host with other stacks). With Turbopack
  // and one worker per CPU the build needed ~2 GB and was killed by the kernel, which `npm` reports only as exit 1.
  // webpack (see the build script) with one worker builds in under 768 MB.
  experimental: { cpus: 1, webpackMemoryOptimizations: true },
  outputFileTracingRoot: path.join(__dirname, '../..'),
  // Same-origin proxy keeps session cookies first-party and hides the API host from browsers.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};
export default config;