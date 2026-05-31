import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  async rewrites() {
    // In production on Firebase, /api/* is handled by hosting rewrites to the Cloud Function.
    // In development, proxy to the local Fastify server.
    if (process.env.NODE_ENV === 'development') {
      return [
        {
          source: '/api/:path*',
          destination: 'http://localhost:3000/api/:path*',
        },
        {
          source: '/uploads/:path*',
          destination: 'http://localhost:3000/uploads/:path*',
        },
      ];
    }
    return [];
  },
};

export default nextConfig;
