import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // pdfjs-dist ships its own worker; keep it external so Next doesn't try to bundle
  // the canvas/node-specific bits into the server build.
  serverExternalPackages: ['pdfjs-dist'],
};

export default nextConfig;
