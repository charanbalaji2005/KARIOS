'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { use } from 'react';

const NAV = [
  { href: '', label: 'Overview' },
  { href: '/editor', label: 'Table editor' },
  { href: '/schema', label: 'Schema' },
  { href: '/storage', label: 'Storage' },
  { href: '/explorer', label: 'API explorer' },
  { href: '/keys', label: 'API keys' },
];

export default function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ ref: string }> | { ref: string };
}) {
  const resolved = params instanceof Promise ? use(params) : params;
  const pathname = usePathname();
  const base = `/project/${resolved.ref}`;

  return (
    <div className="flex min-h-screen">
      <nav aria-label="Project" className="w-56 shrink-0 border-r border-edge bg-panel px-3 py-6">
        <Link href="/projects" className="px-2 font-mono text-xs text-muted hover:text-body">
          ← all projects
        </Link>
        <p className="mt-4 px-2 font-mono text-xs text-signal">{resolved.ref}</p>

        <ul className="mt-6 space-y-0.5">
          {NAV.map((item) => {
            const href = `${base}${item.href}`;
            const active = pathname === href;
            return (
              <li key={item.label}>
                <Link
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={`block rounded px-2 py-1.5 text-sm ${
                    active ? 'bg-raised text-body' : 'text-muted hover:bg-raised hover:text-body'
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
