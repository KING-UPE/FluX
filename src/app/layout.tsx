import type { Metadata } from "next";
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

export const metadata: Metadata = {
  title: "FLUX - High Speed LAN Transfer",
  description: "Secure, high-speed, direct local network file transfer using Wi-Fi and WebRTC. No limits, no clouds, instant local sharing.",
  keywords: ["P2P", "LAN Transfer", "File Sharing", "WebRTC", "Direct File Transfer", "Local Network"],
  authors: [{ name: "Nova Grid" }],
  openGraph: {
    title: "FLUX - P2P LAN Transfer",
    description: "Instantly share large files and folders across your local network. Zero cloud limits.",
    siteName: "FLUX",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "FLUX - P2P LAN Transfer",
    description: "Instantly share large files securely across your local Wi-Fi. It's lightning fast.",
  }
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
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
