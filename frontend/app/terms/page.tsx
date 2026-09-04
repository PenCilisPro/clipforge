import type { Metadata } from "next";
import Link from "next/link";

import { Logo } from "@/components/logo";

export const metadata: Metadata = {
  title: "Terms of Service — ClipForge",
};

export default function TermsPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b">
        <div className="container flex h-16 items-center justify-between">
          <Logo />
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← Back to home
          </Link>
        </div>
      </header>
      <main className="container max-w-3xl flex-1 py-12">
        <h1 className="text-3xl font-bold tracking-tight">Terms of Service</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: September 4, 2026</p>

        <div className="mt-8 space-y-6 text-sm leading-relaxed text-muted-foreground">
          <section>
            <h2 className="text-lg font-semibold text-foreground">1. The service</h2>
            <p className="mt-2">
              ClipForge converts long-form videos you own or have the right to
              use into short-form clips, with AI-selected highlights, automatic
              captions, optional B-roll and background music. The service is
              provided "as is" and we may change or discontinue features at any
              time.
            </p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">2. Your responsibilities</h2>
            <p className="mt-2">
              You may only upload or link videos that you own or have permission
              to use. You are responsible for the content you process and for
              complying with the licenses of any background music you include in
              exported clips. Do not upload unlawful, infringing, or harmful
              content.
            </p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">3. Credits and plans</h2>
            <p className="mt-2">
              Rendering consumes credits (1 credit = 1 minute of video processed)
              according to your plan. Credits are managed by the ClipForge team;
              upgrade requests submitted through the Billing page are reviewed
              and applied manually. Failed renders that consume no render time
              are credited back at our discretion.
            </p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">4. AI-generated output</h2>
            <p className="mt-2">
              Clip selection, captions, B-roll placement and virality scores are
              produced automatically and may be inaccurate. Review clips before
              publishing them. You are responsible for the final content you
              distribute.
            </p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">5. Third-party platforms</h2>
            <p className="mt-2">
              Scheduling and publishing to YouTube, Instagram, TikTok and
              Facebook is subject to those platforms' terms and APIs. We are not
              responsible for content removed or moderated by third-party
              platforms.
            </p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">6. Limitation of liability</h2>
            <p className="mt-2">
              To the maximum extent permitted by law, ClipForge is not liable for
              indirect, incidental, or consequential damages, or for lost data,
              revenue, or profits arising from your use of the service.
            </p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">7. Contact</h2>
            <p className="mt-2">
              For questions about these terms, email{" "}
              <a className="underline" href="mailto:support@clipforge.app">
                support@clipforge.app
              </a>
              .
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
