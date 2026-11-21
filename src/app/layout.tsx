import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  themeColor: "#0F766E",
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  title: "Reseller Command Center — eBay Stale Radar & Cross-Listing Hub",
  description:
    "eBay-first reseller operations command center for stale inventory detection, COGS-protected bulk price drops, End & Sell Similar interventions, and multi-channel cross-listing.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "Reseller Hub",
    statusBarStyle: "default",
  },
  icons: {
    icon: "/icon.svg",
    apple: "/icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-[#F7F7F4] text-[#14151A] font-sans selection:bg-[#1D4ED8]/15 selection:text-[#14151A]">
        {children}
      </body>
    </html>
  );
}
