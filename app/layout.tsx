import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./theme.css";
import ThemeControl from "./theme-control";

export const metadata: Metadata = {
  title: "Food Coster",
  description: "점심과 저녁 식대를 빠르게 기록하고 관리합니다.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: { capable: true, title: "Food Coster", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f5f6f8",
};

const themeBootScript = `(() => {
  try {
    const stored = localStorage.getItem("food-coster-theme");
    const preference = stored === "light" || stored === "dark" ? stored : "system";
    const resolved = preference === "system"
      ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : preference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  } catch {}
})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko" suppressHydrationWarning>
    <head><script dangerouslySetInnerHTML={{ __html: themeBootScript }}/></head>
    <body>{children}<ThemeControl/></body>
  </html>;
}
