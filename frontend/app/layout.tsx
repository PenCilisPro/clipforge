import "./globals.css";
import type { Metadata } from "next";
import { Anton, Bebas_Neue, Archivo_Black, Poppins } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { CookieConsent } from "@/components/cookie-consent";

// Caption fonts — bundled so the editor/dialog previews render exactly like
// the final Shotstack captions.
const anton = Anton({ weight: "400", subsets: ["latin"], variable: "--font-caption-anton" });
const bebas = Bebas_Neue({ weight: "400", subsets: ["latin"], variable: "--font-caption-bebas" });
const archivo = Archivo_Black({ weight: "400", subsets: ["latin"], variable: "--font-caption-archivo" });
const poppins = Poppins({ weight: "700", subsets: ["latin"], variable: "--font-caption-poppins" });

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
        className={`${anton.variable} ${bebas.variable} ${archivo.variable} ${poppins.variable} font-sans`}
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
