'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, session } from '@/lib/api';
import { Alert, Button, Field, Input } from '@/components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('dev@kairosdb.local');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ accessToken: string; user?: { email: string; id: string } }>(`/api/v1/auth/${mode === 'login' ? 'login' : 'signup'}`, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      session.set(data.accessToken);
      session.setUser(data.user ?? { email });
      router.push('/projects');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="mb-10">
        <p className="font-mono text-xs tracking-wide text-signal">kairosdb</p>
        <h1 className="mt-3 text-2xl font-semibold text-body">
          {mode === 'login' ? 'Sign in to your projects' : 'Create your account'}
        </h1>
        <p className="mt-2 text-sm text-muted">
          A Postgres database, REST API, auth, storage and realtime for every project you make.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <Field label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </Field>
        <Field label="Password" hint={mode === 'signup' ? 'At least 10 characters.' : undefined}>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={10}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
        </Field>

        {error ? <Alert>{error}</Alert> : null}

        <Button type="submit" variant="primary" disabled={busy} className="w-full justify-center">
          {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </Button>
      </form>

      <button
        onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(null); }}
        className="mt-6 text-sm text-muted underline-offset-4 hover:text-body hover:underline"
      >
        {mode === 'login' ? 'No account yet? Create one' : 'Already have an account? Sign in'}
      </button>
    </main>
  );
}
