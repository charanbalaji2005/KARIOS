'use client';

import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
};

const VARIANTS = {
  primary: 'bg-signal text-white hover:bg-[#6B58EF] disabled:bg-raised disabled:text-muted',
  ghost: 'bg-raised text-body hover:bg-[#252B37] border border-edge',
  danger: 'bg-transparent text-coral border border-[#4A2B2B] hover:bg-[#2A1C1C]',
} as const;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'ghost', size = 'md', className = '', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      {...props}
      className={`inline-flex items-center gap-2 rounded font-medium transition-colors disabled:cursor-not-allowed
        ${size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm'} ${VARIANTS[variant]} ${className}`}
    />
  );
});

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className = '', ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      {...props}
      className={`w-full rounded border border-edge bg-raised px-3 py-2 text-sm text-body
        placeholder:text-muted focus:border-signal focus:outline-none ${className}`}
    />
  );
});

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm text-body">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export function Panel({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-edge bg-panel">
      {title ? (
        <header className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h2 className="text-sm font-medium text-body">{title}</h2>
          {action}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Empty({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <p className="text-sm font-medium text-body">{title}</p>
      <p className="max-w-sm text-sm text-muted">{description}</p>
      {action}
    </div>
  );
}

export function Alert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded border border-[#4A2B2B] bg-[#241A1A] px-3 py-2 text-sm text-coral">
      {children}
    </p>
  );
}

export function StatusDot({ status }: { status: string }) {
  const color = status === 'active' ? 'bg-mint' : status === 'failed' ? 'bg-coral' : 'bg-amber';
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} aria-hidden />;
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="h-9 rounded bg-raised" />
      ))}
    </div>
  );
}
