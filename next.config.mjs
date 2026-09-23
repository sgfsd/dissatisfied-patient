/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
  /* better-sqlite3 — нативный модуль: бандлить его нельзя, иначе сборщик
     пытается разрешить его зависимости («fs») для всех рантаймов и падает. */
  serverExternalPackages: ['better-sqlite3'],
  experimental: { optimizePackageImports: [] },
};

export default nextConfig;
