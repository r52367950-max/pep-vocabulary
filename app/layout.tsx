import type { Metadata, Viewport } from "next";
import "@fontsource-variable/noto-sans";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/source-serif-4";
import "./globals.css";

export const metadata: Metadata = {
  title: "词迹 · 人教版英语词汇学习",
  description: "面向山东高中生的本地优先、可追溯人教版初高中英语词汇学习应用。",
  applicationName: "词迹",
  manifest: "/manifest.webmanifest",
  other: { "codex-preview": "development" },
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg", apple: "/icons/icon-192.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f7f5" },
    { media: "(prefers-color-scheme: dark)", color: "#0d1717" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
