import type { Metadata } from "next";

import { Navbar } from "@/components/landing/navbar";
import { Pricing } from "@/components/landing/pricing";
import { Footer } from "@/components/landing/footer";

export const metadata: Metadata = {
  title: "Pricing — ClipForge",
  description: "Simple pricing that scales with you. Start free, upgrade when your clips start earning.",
};

export default function PricingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <Navbar />
      <main className="flex flex-1 flex-col justify-center">
        <Pricing />
      </main>
      <Footer />
    </div>
  );
}
