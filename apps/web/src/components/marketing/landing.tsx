import {
  ArrowRight,
  BarChart3,
  Building2,
  Check,
  Code2,
  Cpu,
  FileText,
  Gauge,
  GitBranch,
  Globe,
  KeyRound,
  Layers,
  Lock,
  Mail,
  MessageSquare,
  Plug,
  ScrollText,
  Server,
  ShieldCheck,
  Terminal,
  Users,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Logo, LogoMark } from "@/components/ui/logo";
import { HeroVisual } from "./hero-visual";

const CONTACT = "mailto:hello@aatmiq.com?subject=Aatmiq%20demo";

function Section({ id, children, className = "" }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={`mx-auto w-full max-w-6xl px-4 sm:px-6 ${className}`}>
      {children}
    </section>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="mb-3 text-[12px] tracking-[0.12em] text-fg-subtle uppercase">{children}</div>;
}

export function Landing() {
  return (
    <div className="min-h-dvh overflow-x-clip bg-bg">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-border bg-bg/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/" aria-label="Aatmiq home">
            <Logo />
          </Link>
          <nav className="hidden items-center gap-7 text-sm text-fg-muted md:flex">
            <a href="#product" className="transition-colors hover:text-fg">Product</a>
            <a href="#privacy" className="transition-colors hover:text-fg">Privacy</a>
            <a href="#admin" className="transition-colors hover:text-fg">For admins</a>
            <a href="#plans" className="transition-colors hover:text-fg">Plans</a>
          </nav>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link href="/login">Sign in</Link>
            </Button>
            <Button asChild variant="primary" size="sm">
              <a href={CONTACT}>Book a demo</a>
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <Section className="pt-16 pb-20 text-center sm:pt-24">
        <div className="mx-auto mb-6 inline-flex animate-rise items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-[12.5px] text-fg-muted">
          <span className="size-1.5 rounded-full bg-accent" />
          Private AI for teams · runs on your own servers
        </div>
        <h1 className="mx-auto max-w-4xl animate-rise font-serif text-[56px] leading-[1.02] tracking-[-0.03em] text-fg [animation-delay:60ms] sm:text-[88px]">
          Your own AI.
          <span className="block text-fg-subtle italic">Nowhere else.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl animate-rise text-[16px] leading-relaxed text-fg-muted [animation-delay:120ms]">
          Aatmiq gives your whole company a chat assistant, autonomous AI agents and a full code editor in one
          workspace you own. It runs open-source models on your infrastructure, so your data never goes to a third-party AI.
        </p>
        <div className="mt-9 flex animate-rise flex-wrap items-center justify-center gap-3 [animation-delay:180ms]">
          <Button asChild variant="primary" size="lg">
            <a href={CONTACT}>
              Book a demo <ArrowRight className="size-4" />
            </a>
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link href="/login">Sign in to your workspace</Link>
          </Button>
        </div>
        <div className="mt-16">
          <HeroVisual />
        </div>
        <div className="mt-14 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-[13px] text-fg-subtle">
          <span className="text-fg-muted">Runs the models you choose:</span>
          {["DeepSeek", "Qwen", "Llama", "Gemma", "Mistral", "gpt-oss", "via Ollama or vLLM"].map((m) => (
            <span key={m} className="font-medium">{m}</span>
          ))}
        </div>
      </Section>

      {/* Three sections */}
      <Section id="product" className="py-20">
        <div className="mx-auto max-w-2xl text-center">
          <Eyebrow>One platform, three ways to work</Eyebrow>
          <h2 className="font-serif text-[36px] leading-tight tracking-[-0.02em] sm:text-[44px]">Everything your team uses AI for, in one place.</h2>
          <p className="mt-4 text-fg-muted">
            Replace separate subscriptions for chat, agents and coding tools with one private workspace, one login and one
            admin panel.
          </p>
        </div>
        <div className="mt-14 grid gap-4 md:grid-cols-3">
          <Pillar
            icon={<MessageSquare />}
            name="Chat"
            tagline="Ask, write, understand."
            points={["Private assistant for every employee", "Upload PDFs, docs and spreadsheets", "Answers cite your documents", "Folders, search and sharing"]}
          />
          <Pillar
            icon={<Workflow />}
            name="Work AI"
            tagline="Hand off a task. Get it done."
            points={["Agents that plan and act on your behalf", "Connect Slack, Gmail, Drive, GitHub, GitLab", "Private web search and reusable skills", "Approvals before anything risky"]}
            soon
          />
          <Pillar
            icon={<Code2 />}
            name="Code"
            tagline="A full IDE, with an agent inside."
            points={["Built on VS Code: editor, terminal, git, debug", "Desktop app and in the browser", "AI panel that edits files directly", "Works fine with AI switched off"]}
            soon
          />
        </div>
      </Section>

      {/* Privacy */}
      <Section id="privacy" className="py-20">
        <div className="grid items-center gap-12 rounded-2xl border border-border bg-surface p-8 sm:p-12 lg:grid-cols-2">
          <div>
            <Eyebrow>Privacy by architecture</Eyebrow>
            <h2 className="font-serif text-[36px] leading-tight tracking-[-0.02em] sm:text-[44px]">Nothing leaves your building.</h2>
            <p className="mt-4 leading-relaxed text-fg-muted">
              Cloud AI tools send your prompts, code and documents to someone else&apos;s servers. Aatmiq installs on
              your hardware or private cloud and runs open-source models there, so your data stays inside your network.
            </p>
            <ul className="mt-7 space-y-3 text-[15px]">
              {[
                "Prompts, files and code stay in your database",
                "Open-source models on your GPUs, or a provider you trust",
                "Our license server only ever sees seat counts, never content",
                "Full audit log of every sign-in, change and agent action",
              ].map((t) => (
                <li key={t} className="flex gap-3">
                  <Check className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
                  <span className="text-fg-muted">{t}</span>
                </li>
              ))}
            </ul>
          </div>
          <PrivacyDiagram />
        </div>
      </Section>

      {/* Admin */}
      <Section id="admin" className="py-20">
        <div className="mx-auto max-w-2xl text-center">
          <Eyebrow>Built for the people who run it</Eyebrow>
          <h2 className="font-serif text-[36px] leading-tight tracking-[-0.02em] sm:text-[44px]">Control who uses what, and how much.</h2>
        </div>
        <div className="mt-14 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
          {[
            { i: <Layers />, t: "Workspaces per team", d: "Engineering, Sales, Finance: each with its own models, budget and tools." },
            { i: <Gauge />, t: "Token budgets", d: "Set budgets per team and per person. Usage is split fairly by default and adjustable." },
            { i: <Mail />, t: "Request more, in-app", d: "Out of tokens? Employees ask; admins approve in one click. Paused work resumes." },
            { i: <Cpu />, t: "Bring any model", d: "Ollama, vLLM or any OpenAI-compatible endpoint. Enable models per team." },
            { i: <BarChart3 />, t: "Usage analytics", d: "Tokens by team, person, model and section, with CSV export." },
            { i: <KeyRound />, t: "Single sign-on", d: "Email and password, Google, Microsoft, with SAML/OIDC for larger orgs." },
            { i: <Users />, t: "Roles that fit", d: "Org admins, workspace admins and members, each with clear permissions." },
            { i: <ScrollText />, t: "Audit log", d: "Every sign-in, setting change and approval is recorded." },
            { i: <Building2 />, t: "Your brand", d: "Your logo, name and accent color across the whole product." },
          ].map((f) => (
            <div key={f.t} className="group bg-surface p-6 transition-colors hover:bg-surface-2">
              <div className="mb-4 flex size-9 items-center justify-center rounded-lg border border-border bg-bg-subtle text-fg-muted transition-colors group-hover:border-border-strong group-hover:text-fg [&>svg]:size-4">
                {f.i}
              </div>
              <h3 className="text-[14px] text-fg">{f.t}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{f.d}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* How it works */}
      <Section className="py-20">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <Eyebrow>Up and running in a day</Eyebrow>
            <h2 className="font-serif text-[36px] leading-tight tracking-[-0.02em] sm:text-[44px]">Install it. Connect your models. Invite your team.</h2>
            <p className="mt-4 text-fg-muted">We help you set it up and keep it updated. You keep full ownership of the server and the data.</p>
          </div>
          <ol className="space-y-3">
            {[
              { i: <Server />, t: "Install on your server", d: "One command on any Linux machine or private cloud. Docker-based, with updates and backups built in." },
              { i: <Cpu />, t: "Connect your models", d: "Point Aatmiq at Ollama, vLLM or a private endpoint. We can run the model servers for you if you prefer." },
              { i: <Users />, t: "Invite your team", d: "Create workspaces, set budgets and send invites. People sign in with their work account." },
            ].map((s, idx) => (
              <li key={s.t} className="flex gap-4 rounded-2xl border border-border bg-surface p-5">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2 font-mono text-sm text-fg">
                  {idx + 1}
                </div>
                <div>
                  <h3 className="font-medium">{s.t}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-fg-muted">{s.d}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </Section>

      {/* Plans */}
      <Section id="plans" className="py-20">
        <div className="mx-auto max-w-2xl text-center">
          <Eyebrow>Plans</Eyebrow>
          <h2 className="font-serif text-[36px] leading-tight tracking-[-0.02em] sm:text-[44px]">Start with chat. Grow into agents and code.</h2>
          <p className="mt-4 text-fg-muted">Per-seat plans with an annual platform fee that covers installation, updates and support.</p>
        </div>
        <div className="mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Plan name="Chat" desc="A private assistant for everyone." items={["Chat + document Q&A", "Up to 3 workspaces", "Google / Microsoft sign-in", "30-day audit log"]} />
          <Plan name="Work" desc="Agents that get things done." items={["Everything in Chat", "Work AI agents", "Connectors and web search", "Up to 10 workspaces"]} />
          <Plan name="Complete" desc="Chat, agents and code." items={["Everything in Work", "Aatmiq Code IDE", "Desktop and browser", "Unlimited workspaces"]} featured />
          <Plan name="Enterprise" desc="For larger organizations." items={["Everything in Complete", "SAML / OIDC, LDAP", "Managed model hosting", "SLA and dedicated support"]} />
        </div>
      </Section>

      {/* CTA */}
      <Section className="py-24">
        <div className="relative overflow-hidden rounded-2xl border border-border bg-surface px-6 py-16 text-center sm:px-12">
          <LogoMark className="relative mx-auto mb-6 size-10" />
          <h2 className="relative font-serif text-[36px] leading-tight tracking-[-0.02em] sm:text-[48px]">Give your team AI they can trust.</h2>
          <p className="relative mx-auto mt-4 max-w-xl text-fg-muted">
            See Aatmiq running on real hardware, with your own documents, in a 30-minute demo.
          </p>
          <div className="relative mt-8 flex flex-wrap justify-center gap-3">
            <Button asChild variant="primary" size="lg">
              <a href={CONTACT}>
                Book a demo <ArrowRight className="size-4" />
              </a>
            </Button>
          </div>
        </div>
      </Section>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-10 text-sm text-fg-subtle sm:flex-row sm:px-6">
          <div className="flex items-center gap-3">
            <LogoMark className="size-5" />
            <span>
              Aatmiq, <span className="italic">ātmik</span>: &ldquo;one&apos;s own&rdquo;.
            </span>
          </div>
          <div className="flex gap-6">
            <a href="#privacy" className="hover:text-fg">Privacy</a>
            <a href={CONTACT} className="hover:text-fg">Contact</a>
            <Link href="/login" className="hover:text-fg">Sign in</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Pillar({ icon, name, tagline, points, soon }: { icon: ReactNode; name: string; tagline: string; points: string[]; soon?: boolean }) {
  return (
    <div className="group relative rounded-xl border border-border bg-surface p-6 transition-[border-color,transform] duration-300 hover:-translate-y-0.5 hover:border-border-strong">
      <div className="mb-5 flex items-center justify-between">
        <div className="flex size-9 items-center justify-center rounded-lg border border-border bg-surface-2 text-fg [&>svg]:size-4">{icon}</div>
        {soon && <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-fg-subtle">Coming soon</span>}
      </div>
      <h3 className="font-serif text-[26px] leading-tight">{name}</h3>
      <p className="mt-1 text-fg-muted">{tagline}</p>
      <ul className="mt-5 space-y-2.5 text-sm">
        {points.map((p) => (
          <li key={p} className="flex gap-2.5 text-fg-muted">
            <Check className="mt-0.5 size-4 shrink-0 text-fg-subtle" /> {p}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Plan({ name, desc, items, featured }: { name: string; desc: string; items: string[]; featured?: boolean }) {
  return (
    <div
      className={`relative flex flex-col rounded-2xl border p-6 ${featured ? "border-fg-subtle bg-surface" : "border-border bg-surface"}`}
    >
      {featured && (
        <span className="absolute -top-2.5 left-6 rounded-full bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-fg">Most complete</span>
      )}
      <h3 className="font-serif text-[24px] leading-tight">{name}</h3>
      <p className="mt-1 text-sm text-fg-muted">{desc}</p>
      <ul className="mt-5 flex-1 space-y-2.5 text-sm">
        {items.map((i) => (
          <li key={i} className="flex gap-2.5 text-fg-muted">
            <Check className="mt-0.5 size-4 shrink-0 text-fg-subtle" /> {i}
          </li>
        ))}
      </ul>
      <Button asChild variant={featured ? "primary" : "outline"} className="mt-6 w-full">
        <a href={CONTACT}>Talk to us</a>
      </Button>
    </div>
  );
}

function PrivacyDiagram() {
  return (
    <div className="relative rounded-xl border border-border bg-bg p-6">
      <div className="mb-3 flex items-center gap-2 text-[12px] font-medium text-fg-subtle">
        <Lock className="size-3.5" /> Your network
      </div>
      <div className="grid grid-cols-2 gap-3 rounded-xl border border-dashed border-border-strong p-4">
        {[
          { i: <Users />, t: "Employees", d: "Browser & desktop" },
          { i: <LogoMark className="size-4" />, t: "Aatmiq", d: "Web, API, agents" },
          { i: <Cpu />, t: "Models", d: "Ollama / vLLM" },
          { i: <FileText />, t: "Your data", d: "Postgres + files" },
          { i: <Plug />, t: "Connectors", d: "Slack, Drive, Git" },
          { i: <Terminal />, t: "Sandboxes", d: "Per-user containers" },
        ].map((n) => (
          <div key={n.t} className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-fg-muted [&>svg]:size-4">{n.i}</div>
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{n.t}</div>
              <div className="truncate text-[11.5px] text-fg-subtle">{n.d}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-3 rounded-lg border border-border bg-surface p-3 text-[12.5px]">
        <ShieldCheck className="size-4 shrink-0 text-fg-muted" />
        <span className="text-fg-muted">
          Only license status and seat counts reach Aatmiq. <span className="text-fg">No prompts, files or code.</span>
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-[11.5px] text-fg-subtle">
        <span className="inline-flex items-center gap-1"><Globe className="size-3" /> Works air-gapped</span>
        <span className="inline-flex items-center gap-1"><GitBranch className="size-3" /> Self-hosted Git supported</span>
      </div>
    </div>
  );
}
