import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  async rewrites() {
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
  },
};

export default nextConfig;
