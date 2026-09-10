"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Box, ScanSearch, Settings, PackagePlus, FileSearch } from "lucide-react";
import clsx from "clsx";

const NAV = [
  { href: "/inventories", label: "Inventories", icon: Box },
  { href: "/identify", label: "Identify", icon: ScanSearch },
  { href: "/search", label: "Deep search", icon: FileSearch },
  { href: "/settings", label: "Settings", icon: Settings },
];

export default function Sidebar() {
  const pathname = usePathname();
  return (
    <aside
      className="w-60 shrink-0 flex flex-col text-indigo-100/70 border-r border-white/5"
      style={{
        background:
          "linear-gradient(180deg, #101430 0%, #141a3f 55%, #1a1445 100%)",
        boxShadow: "1px 0 0 rgba(255,255,255,0.03) inset, 8px 0 32px rgba(23, 20, 61, 0.18)",
      }}
    >
      <div className="flex items-center gap-2.5 px-6 h-16 border-b border-white/[0.06]">
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center text-white"
          style={{
            background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
            boxShadow: "0 2px 8px rgba(99, 102, 241, 0.55), 0 0 20px rgba(139, 92, 246, 0.35)",
          }}
        >
          <ScanSearch size={18} />
        </div>
        <div>
          <div
            className="text-lg font-extrabold leading-none tracking-[0.32em] uppercase"
            style={{
              background: "linear-gradient(120deg, #ffffff 20%, #c7bfff 55%, #8b5cf6 100%)",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
              textShadow: "0 0 24px rgba(139, 92, 246, 0.35)",
            }}
          >
            Dark
          </div>
          <div className="text-[11px] leading-tight text-indigo-200/50 mt-1">visual item search</div>
        </div>
      </div>
      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              className={clsx(
                "relative flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200",
                active
                  ? "text-white"
                  : "text-indigo-100/60 hover:text-white hover:bg-white/[0.06]"
              )}
              style={
                active
                  ? {
                      background: "linear-gradient(135deg, rgba(99,102,241,0.95), rgba(139,92,246,0.9))",
                      boxShadow: "0 4px 16px rgba(99, 102, 241, 0.45)",
                    }
                  : undefined
              }
            >
              <Icon size={17} />
              {label}
            </Link>
          );
        })}
        <Link
          href="/inventories?import=1"
          className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-indigo-100/60 hover:text-white hover:bg-white/[0.06] transition-all duration-200"
        >
          <PackagePlus size={17} />
          Import inventory
        </Link>
      </nav>
      <div className="px-6 py-4 border-t border-white/[0.06] text-[11px] text-indigo-200/40">
        Read-only sources · keys encrypted at rest
      </div>
    </aside>
  );
}
