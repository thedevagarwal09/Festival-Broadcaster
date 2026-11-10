import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';

export const metadata: Metadata = {
  title: 'Privacy policy · Festival Broadcaster',
  description: 'What Festival Broadcaster stores, what it never collects, and how to erase it.',
};

const LAST_UPDATED = '10 November 2026';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold text-stone-900">{title}</h2>
      <div className="space-y-2 text-sm leading-relaxed text-stone-600">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <main className="relative mx-auto max-w-3xl p-4 pt-20 md:p-8 md:pt-8">
      <ThemeToggle className="absolute right-4 top-4 md:right-8 md:top-8" />
      <Link href="/" className="btn-ghost -ml-3 mb-4 text-sm">
        <ArrowLeft className="h-4 w-4" /> Back
      </Link>

      <article className="card space-y-7 p-6 md:p-8">
        <header className="space-y-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
            <ShieldCheck className="h-6 w-6" />
          </span>
          <h1 className="text-2xl font-bold text-stone-900">Privacy policy</h1>
          <p className="text-sm text-stone-500">Last updated {LAST_UPDATED}</p>
          <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm leading-relaxed text-emerald-800">
            <strong>In short:</strong> everything stays on the server that runs this app. Nothing is uploaded to
            any cloud, sold, shared or used for advertising. Your chats are never downloaded. You can erase all of it
            whenever you like.
          </p>
        </header>

        <Section title="What is stored, and why">
          <p>Only what is needed to send your greetings, and only on this server:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>WhatsApp login keys</strong>, created when you scan the QR code, so the app can send messages
              as you.
            </li>
            <li>
              <strong>Contact names and phone numbers</strong> from your WhatsApp address book, so you can pick who
              gets a greeting.
            </li>
            <li>
              <strong>Your groups, campaigns and drafts</strong>: the message you wrote, who it went to, and whether
              each send worked.
            </li>
            <li>
              <strong>Images, videos and e-cards</strong> you upload or create to attach to a greeting.
            </li>
            <li>
              <strong>Your settings</strong> such as quiet hours. Each person has their own; nobody else can see
              or change them.
            </li>
          </ul>
        </Section>

        <Section title="What is never collected">
          <ul className="list-disc space-y-1 pl-5">
            <li>Your chats: no chat history or incoming messages are ever downloaded or read.</li>
            <li>Your phone&apos;s photos, files, calls or location.</li>
            <li>Passwords or payment details: none are ever asked for.</li>
            <li>Analytics, advertising IDs or tracking cookies: this app has none.</li>
          </ul>
        </Section>

        <Section title="Where your data goes">
          <p>
            Your greetings go only to WhatsApp, which delivers them to the people you chose, end-to-end encrypted
            like any other WhatsApp message. Nothing is sent to any other company or service.
          </p>
          <p>
            The only other connection the server makes is a check for the current WhatsApp Web version number. It
            contains no personal data.
          </p>
          <p>
            Your browser remembers a few things locally (which session it is using, light or dark mode, and your
            compression choice). These never leave your device.
          </p>
        </Section>

        <Section title="How long it is kept">
          <p>
            Data stays until you remove it. <strong>Unlink</strong> deletes the WhatsApp login keys straight away
            but keeps your contacts and groups, so linking again picks up where you left off.{' '}
            <strong>Erase my data</strong> deletes everything of yours, as described below.
          </p>
        </Section>

        <Section title="Your controls">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>Unlink</strong> from the dashboard, or on your phone: WhatsApp → Settings → Linked devices.
            </li>
            <li>
              <strong>Erase my data</strong> (dashboard header, or below the QR code) permanently deletes your
              WhatsApp login, contacts, groups, campaigns, draft, settings and uploads from this server, and rewrites the
              database so deleted entries can&apos;t be recovered. Nobody else&apos;s data is affected, and nobody
              else can erase yours.
            </li>
            <li>Delete a group, an uploaded attachment or your draft at any time.</li>
          </ul>
        </Section>

        <Section title="Keeping it secure">
          <p>
            Your data is kept separate from everyone else&apos;s on this server. Your dashboard is tied to this
            browser by a private random key stored in it, so anyone who uses this browser can open your dashboard
            and send from your linked WhatsApp. On a shared or public computer, unlink or erase your data when
            you&apos;re done.
          </p>
        </Section>

        <Section title="People you message">
          <p>
            Recipients&apos; names and numbers are used only to send them your greetings. They are never contacted
            for any other reason, and never shared.
          </p>
        </Section>

        <Section title="Changes">
          <p>If this policy changes, the date at the top will change with it.</p>
        </Section>
      </article>
    </main>
  );
}
