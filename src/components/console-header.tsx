"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useState } from "react";

function NavIcon({ name }: { name: "command" | "fleet" | "agents" | "schedules" | "docs" }) {
  if (name === "command") {
    return <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" aria-hidden="true"><path d="M4 4.5h12v8.5H9l-3.5 2.5V13H4z" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" /><path d="M7 7.5h6M7 10h4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" /></svg>;
  }
  if (name === "fleet") {
    return <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" aria-hidden="true"><rect x="3.5" y="3.5" width="5" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" /><rect x="11.5" y="3.5" width="5" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" /><rect x="3.5" y="11.5" width="5" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" /><rect x="11.5" y="11.5" width="5" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>;
  }
  if (name === "agents") {
    return <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" aria-hidden="true"><circle cx="10" cy="7" r="3" fill="none" stroke="currentColor" strokeWidth="1.35" /><path d="M4.5 16c.5-3 2.4-4.5 5.5-4.5s5 1.5 5.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" /></svg>;
  }
  if (name === "schedules") {
    return <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" aria-hidden="true"><circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.35" /><path d="M10 6.5v4l2.8 1.7" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  return <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" aria-hidden="true"><path d="M5 3.5h7l3 3V16.5H5z" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" /><path d="M12 3.5v3h3M7.5 10h5M7.5 12.5h5" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" /></svg>;
}

const NAV = [
  { href: "/", label: "Command", description: "Plan and assign work", icon: "command" },
  { href: "/board", label: "Fleet", description: "Track every agent task", icon: "fleet" },
  { href: "/agents", label: "Agents", description: "Edit specialist prompts", icon: "agents" },
  { href: "/schedules", label: "Schedules", description: "Run recurring work", icon: "schedules" },
  { href: "/docs", label: "Docs", description: "Browse saved documents", icon: "docs" },
] as const;

function NavLinks({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Mission Control sections" className={mobile ? "grid grid-cols-5 border-t border-line bg-panel" : "mt-6 space-y-2 px-3"}>
      {NAV.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={mobile
              ? `relative flex min-w-0 flex-col items-center gap-1 px-1 py-2.5 text-[10px] font-medium transition-colors ${active ? "text-ink" : "text-ink-faint"}`
              : `group flex items-start gap-3 rounded-lg border px-3 py-3 transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal ${active ? "border-line-strong bg-panel-hi text-ink" : "border-transparent bg-transparent text-ink-faint hover:border-line hover:text-ink-soft"}`
            }
          >
            <span className={mobile
              ? active ? "text-signal" : "text-ink-faint"
              : `flex h-8 w-5 shrink-0 items-center justify-center ${active ? "text-signal" : "text-ink-faint group-hover:text-ink-soft"}`
            }><NavIcon name={item.icon} /></span>
            {mobile ? (
              <span>{item.label}</span>
            ) : (
              <span className="min-w-0 pt-0.5">
                <span className="block text-[13px] font-semibold leading-tight text-current">{item.label}</span>
                <span className="mt-1 block truncate text-[10px] font-normal leading-tight text-ink-faint">{item.description}</span>
              </span>
            )}
            {mobile && active && <span aria-hidden="true" className="absolute inset-x-5 bottom-0 h-px bg-signal" />}
          </Link>
        );
      })}
    </nav>
  );
}

export function ConsoleShell({ children }: { children: ReactNode }) {
  const [sidebarHidden, setSidebarHidden] = useState(false);

  function toggleSidebar() {
    setSidebarHidden((hidden) => !hidden);
  }

  return (
    <div className="relative flex h-dvh overflow-hidden bg-deck">
      <aside className={`${sidebarHidden ? "hidden" : "hidden md:flex"} w-[236px] shrink-0 flex-col border-r border-line bg-panel`}>
        <Link href="/" className="flex h-[72px] items-center gap-2.5 px-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal">
          <span className="text-signal"><Mark /></span>
          <span className="font-display text-[17px] font-extrabold tracking-[-0.03em] text-ink">The Squad</span>
        </Link>
        <NavLinks />
      </aside>

      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={sidebarHidden ? "Show navigation" : "Hide navigation"}
        title={sidebarHidden ? "Show navigation" : "Hide navigation"}
        className={`absolute top-4 z-20 hidden h-7 w-7 items-center justify-center rounded-md border border-line bg-panel text-ink-faint transition-colors hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal md:flex ${sidebarHidden ? "left-3" : "left-[198px]"}`}
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
          <path d={sidebarHidden ? "m6 3 5 5-5 5" : "m10 3-5 5 5 5"} fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <div className={`flex min-w-0 flex-1 flex-col ${sidebarHidden ? "md:pl-12" : ""}`}>
        <header className="flex h-14 shrink-0 items-center border-b border-line bg-panel px-3 md:hidden">
          <span className="text-signal"><Mark /></span>
          <span className="ml-2 font-display text-[15px] font-extrabold tracking-[-0.03em] text-ink">The Squad</span>
        </header>
        <div className="min-h-0 flex-1">{children}</div>
        <div className="shrink-0 md:hidden"><NavLinks mobile /></div>
      </div>
    </div>
  );
}
