import type { NextConfig } from "next";
import path from "node:path";
import fs from "node:fs";
import withPWA from "next-pwa";

const dev = process.env.NODE_ENV !== "production";

// 从根目录 package.json 读取版本号，编译时自动注入
const rootPkgPath = path.join(__dirname, "..", "package.json");
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));
const appVersion = rootPkg.version || "0.0.0";

// Sub2API 嵌入构建（docs/sub2api-embed.md §1）：静态资源挂在 /_nova 下，API 仍在站点根 /api/nova、/api/v1；
// 关闭 PWA service worker（避免缓存旧版本与作用域问题）。
const embed = process.env.NEXT_PUBLIC_NOVA_EMBED === "1";
const embedBasePath = "/_nova";

const nextConfig: NextConfig = {
  // 显式声明追踪根目录，避免 Next.js 16 在 monorepo/多 lockfile 场景下产生警告
  outputFileTracingRoot: path.join(__dirname),
  // 仅在生产构建时启用静态导出，开发模式关闭以支持 HMR 热更新
  ...(dev ? {} : { output: "export" }),
  trailingSlash: true,
  ...(embed ? { basePath: embedBasePath, assetPrefix: embedBasePath } : {}),
  images: {
    unoptimized: true,
  },
  // 编译时自动注入版本号，前端通过 process.env.NEXT_PUBLIC_APP_VERSION 访问
  env: {
    NEXT_PUBLIC_APP_VERSION: appVersion,
    NEXT_PUBLIC_NOVA_EMBED: embed ? "1" : "",
    NEXT_PUBLIC_NOVA_BASE_PATH: embed ? embedBasePath : "",
  },
};

export default withPWA({
  dest: "public",
  disable: dev || embed,
  register: true,
  skipWaiting: true,
})(nextConfig);
