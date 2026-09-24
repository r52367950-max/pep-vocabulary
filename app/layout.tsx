import type { Metadata, Viewport } from "next";
import "./studio-controls.css";
import "./globals.css";
import "./reading-surfaces.css";
import "./interface.css";
import "./settings-dialog.css";
import "./learn.css";

export const metadata: Metadata = {
  title: "词迹 · 人教版英语词汇学习",
  description: "人教版英语词汇学习。复习单词、练习听写，也在短文中理解词义。",
  applicationName: "词迹",
  manifest: "/manifest.webmanifest",
  other: { "codex-preview": "development" },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
    apple: "/icons/app-192.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
