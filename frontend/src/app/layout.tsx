import type { Metadata } from "next";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import Script from "next/script";
import { ServiceWorkerManager } from "@/components/ServiceWorkerManager";
import { withBasePath } from "@/lib/embed/public-path";
import "./globals.css";

// 嵌入构建：静态资源在 /_nova 下；不注册 PWA（无 manifest），主题与本地存储由父页会话决定
const EMBED = process.env.NEXT_PUBLIC_NOVA_EMBED === '1';

export const metadata: Metadata = {
  title: EMBED ? "创作工作台" : "Nova Studio - AI 视频/图像生成器",
  description: "Nova Studio AI 视频/图像生成工作台",
  icons: {
    icon: [
      { url: withBasePath('/favicon.png'), type: 'image/png' },
      { url: withBasePath('/icon-192.png'), sizes: '192x192', type: 'image/png' },
      { url: withBasePath('/icon-512.png'), sizes: '512x512', type: 'image/png' },
    ],
    shortcut: withBasePath('/favicon.png'),
    apple: withBasePath('/icon-192.png'),
  },
  ...(EMBED ? {} : { manifest: '/manifest.json' }),
  other: {
    'theme-color': '#1a1a2e',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {EMBED ? (
          <Script
            id="embed-init"
            strategy="beforeInteractive"
            dangerouslySetInnerHTML={{
              // 嵌入模式不读 localStorage（与 sub2api 同源，键未分区前不能读）。
              // 首屏先按同源父页的深浅色设置，避免闪烁；会话到达后以会话里的 theme 为准。
              __html: `(function(){var r=document.documentElement;r.setAttribute('data-nova-embed','1');try{var p=window.parent;if(p&&p!==window){var d=p.document.documentElement.classList.contains('dark');r.setAttribute('data-theme',d?'dark':'light');r.classList.toggle('dark',d);}}catch(e){}})();`,
            }}
          />
        ) : (<>
        <Script
          id="theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  const theme = window.localStorage.getItem('theme');
                  if (theme === 'dark' || theme === 'light') {
                    document.documentElement.setAttribute('data-theme', theme);
                  } else {
                    document.documentElement.removeAttribute('data-theme');
                  }
                } catch {
                  document.documentElement.removeAttribute('data-theme');
                }
              })();
            `,
          }}
        />
        <Script
          id="wide-mode-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var stored = window.localStorage.getItem('nova-wide-mode');
                  var wide = stored === 'enabled' && window.innerWidth >= 1280;
                  if (wide) {
                    document.documentElement.setAttribute('data-wide-mode', '');
                  }
                } catch {}
              })();
            `,
          }}
        />
        </>)}
      </head>
      <body
        className="antialiased min-h-screen bg-background text-foreground"
      >
        <div id="app-boot-loader" className="fixed inset-0 z-[99999] flex items-center justify-center bg-background" suppressHydrationWarning>
          <svg className="animate-spin h-8 w-8 text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
        <TooltipProvider>
          {!EMBED && <ServiceWorkerManager />}
          <ErrorBoundary>
            <main>
              {children}
            </main>
          </ErrorBoundary>
        </TooltipProvider>
      </body>
    </html>
  );
}
