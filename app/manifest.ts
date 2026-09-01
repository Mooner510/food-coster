import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Food Coster",
    short_name: "Food Coster",
    description: "점심과 저녁 식대를 빠르게 기록하고 관리합니다.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f5f6f8",
    theme_color: "#f5f6f8",
    orientation: "portrait",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
