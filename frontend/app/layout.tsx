import "./globals.css";
import type { Metadata } from "next";
import {
  Anton,
  Bebas_Neue,
  Archivo_Black,
  Poppins,
  Bangers,
  Luckiest_Guy,
  Titan_One,
  Russo_One,
  Righteous,
  Permanent_Marker,
} from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { CookieConsent } from "@/components/cookie-consent";

// Caption fonts — bundled so the editor/dialog previews render exactly like
// the final Shotstack captions.
const anton = Anton({ weight: "400", subsets: ["latin"], variable: "--font-caption-anton" });
const bebas = Bebas_Neue({ weight: "400", subsets: ["latin"], variable: "--font-caption-bebas" });
const archivo = Archivo_Black({ weight: "400", subsets: ["latin"], variable: "--font-caption-archivo" });
const poppins = Poppins({ weight: "700", subsets: ["latin"], variable: "--font-caption-poppins" });
const bangers = Bangers({ weight: "400", subsets: ["latin"], variable: "--font-caption-bangers" });
const luckiest = Luckiest_Guy({ weight: "400", subsets: ["latin"], variable: "--font-caption-luckiest" });
const titan = Titan_One({ weight: "400", subsets: ["latin"], variable: "--font-caption-titan" });
const russo = Russo_One({ weight: "400", subsets: ["latin"], variable: "--font-caption-russo" });
const righteous = Righteous({ weight: "400", subsets: ["latin"], variable: "--font-caption-righteous" });
const marker = Permanent_Marker({ weight: "400", subsets: ["latin"], variable: "--font-caption-marker" });

export const metadata: Metadata = {
  title: "ClipForge — Turn Long Videos Into Viral Clips",
  description:
    "ClipForge automatically converts podcasts, YouTube videos and webinars into vertical, caption-ready clips for TikTok, Reels and Shorts.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${anton.variable} ${bebas.variable} ${archivo.variable} ${poppins.variable} ${bangers.variable} ${luckiest.variable} ${titan.variable} ${russo.variable} ${righteous.variable} ${marker.variable} font-sans`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <CookieConsent />
          <Toaster richColors position="top-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
