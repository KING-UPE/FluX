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

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://flu-x.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Flux by King UPE – Instant P2P File Transfer | No Cloud, No Limits",
    template: "%s | Flux by King UPE",
  },
  description:
    "Flux by King UPE is a free, secure, peer-to-peer file transfer app. Share files & folders instantly across devices over Wi-Fi or the internet using WebRTC. No sign-up, no cloud storage, no file-size limits.",
  keywords: [
    "Flux",
    "Flux by King UPE",
    "King UPE",
    "KING-UPE",
    "P2P file transfer",
    "LAN file transfer",
    "WebRTC file sharing",
    "send files between phone and PC",
    "local network file transfer",
    "share files without internet",
    "direct file transfer",
    "free file sharing app",
    "no cloud file transfer",
    "Wi-Fi file transfer",
    "cross-device file sharing",
    "send folder to phone",
    "browser file transfer",
    "instant file sharing",
  ],
  authors: [{ name: "King UPE", url: "https://github.com/KING-UPE" }],
  creator: "King UPE",
  publisher: "King UPE",
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  alternates: {
    canonical: SITE_URL,
  },
  openGraph: {
    title: "Flux by King UPE – Instant P2P File Transfer",
    description:
      "Share files & folders instantly between any device. No cloud, no limits, no sign-up. Just open and send.",
    url: SITE_URL,
    siteName: "Flux by King UPE",
    type: "website",
    locale: "en_US",
    images: [
      {
        url: `${SITE_URL}/og-image.png`,
        width: 1200,
        height: 630,
        alt: "Flux by King UPE – P2P File Transfer App",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Flux by King UPE – Instant P2P File Transfer",
    description:
      "Send files & folders across devices instantly. No cloud, no limits. Built with WebRTC.",
    images: [`${SITE_URL}/og-image.png`],
    creator: "@KingUPE",
  },
  category: "technology",
};

// JSON-LD Structured Data for rich search results
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "Flux",
  alternateName: "Flux by King UPE",
  url: SITE_URL,
  description:
    "Free, secure, peer-to-peer file transfer app. Share files & folders instantly across devices over Wi-Fi or the internet using WebRTC.",
  applicationCategory: "UtilitiesApplication",
  operatingSystem: "Any (Web Browser)",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
  author: {
    "@type": "Person",
    name: "King UPE",
    url: "https://github.com/KING-UPE",
  },
  featureList: [
    "Peer-to-peer file transfer",
    "No file size limit",
    "No cloud storage needed",
    "Works on LAN and Internet",
    "WebRTC encrypted transfer",
    "Folder transfer support",
    "Multi-device broadcast",
    "QR code room sharing",
  ],
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
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
