import type { Metadata } from "next";
import Link from "next/link";

import { Logo } from "@/components/logo";

export const metadata: Metadata = {
  title: "Privacy Policy — ClipForge",
};

export default function PrivacyPage() {
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
        <h1 className="text-3xl font-bold tracking-tight">Privacy Policy</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: September 4, 2026</p>

        <div className="mt-8 space-y-6 text-sm leading-relaxed text-muted-foreground">
          <section>
            <h2 className="text-lg font-semibold text-foreground">What we collect</h2>
            <p className="mt-2">
              When you use ClipForge we collect the account details you give us
              (email address, display name), the videos you upload or link, the
              transcripts and clips generated from them, and basic usage data
              such as projects, clips and credit consumption.
            </p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">How we use it</h2>
            <p className="mt-2">
              Your data is used to operate the service: downloading, transcribing
              and rendering your videos, storing your clips, applying your plan's
              credits, and responding to your feedback. We use essential cookies
              to keep you signed in. Optional analytics cookies — only set with
              your consent — help us understand how the product is used.
            </p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">Third-party processors</h2>
            <p className="mt-2">
              We rely on third parties to run ClipForge: Supabase (database,
              auth, file storage), Railway (application hosting), Shotstack
              (video rendering), Google Cloud Speech-to-Text (transcription),
              z.ai (AI clip selection and B-roll planning), Pexels/Pixabay (stock
              footage) and Jamendo (background music). These providers process
              data on our behalf under their own privacy policies.
            </p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">Your content</h2>
            <p className="mt-2">
              You keep all rights to the videos you upload and the clips
              generated from them. Deleting a project removes its video files,
              clips and captions from our storage. Music tracks provided through
              the Jamendo catalog are licensed under Creative Commons — check the
              track's license before commercial use.
            </p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">Data retention & deletion</h2>
            <p className="mt-2">
              You can delete your projects at any time from the dashboard. For
              full account deletion, contact{" "}
              <a className="underline" href="mailto:support@clipforge.app">
                support@clipforge.app
              </a>
              .
            </p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">Contact</h2>
            <p className="mt-2">
              Questions about this policy? Email{" "}
              <a className="underline" href="mailto:support@clipforge.app">
                support@clipforge.app
              </a>{" "}
              or send feedback from the in-app Feedback page.
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
