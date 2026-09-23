/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  output: process.env.DOCKER_BUILD ? 'standalone' : undefined,
  eslint: { ignoreDuringBuilds: true },
};
