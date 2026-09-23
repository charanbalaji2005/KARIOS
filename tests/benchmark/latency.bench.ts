/**
 * Kairos benchmark suite.
 *
 *   pnpm --filter @kairosdb/tests bench
 *   BENCH_URL=https://api.example.com BENCH_DURATION=30 pnpm ... bench
 *
 * The spec says: never claim a latency number without benchmarking. So this
 * measures, on your hardware, over your network, against your data. Numbers
 * from someone else's machine are decoration.
 *
 * What it reports and why:
 *
 *   P50   what a typical request feels like
 *   P95   what a bad request feels like — the one users complain about
 *   P99   the tail. On a laptop this is where checkpoint stalls, autovacuum
 *         and thermal throttling show up, and it is the number that a mean
 *         would have hidden completely.
 *
 * Means are deliberately not headlined. A mean of 12ms made of 11ms requests
 * and the occasional 900ms stall describes an experience nobody has had.
 */
import { performance } from 'node:perf_hooks';

const BASE = process.env['BENCH_URL'] ?? 'http://localhost:4000';
const EMAIL = process.env['BENCH_EMAIL'] ?? 'dev@kairosdb.local';
const PASSWORD = process.env['BENCH_PASSWORD'] ?? 'kairosdb-dev-password';
const DURATION_S = Number(process.env['BENCH_DURATION'] ?? 10);
const CONCURRENCY = Number(process.env['BENCH_CONCURRENCY'] ?? 16);
const WARMUP_S = Number(process.env['BENCH_WARMUP'] ?? 3);

interface Result {
  name: string;
  samples: number[];
  errors: number;
  bytes: number;
  wallMs: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  // Nearest-rank. With a few thousand samples the interpolation method
  // differs in the third decimal and costs clarity.
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

function summarise(result: Result) {
  const sorted = [...result.samples].sort((a, b) => a - b);
  const total = sorted.reduce((a, b) => a + b, 0);
  return {
    name: result.name,
    requests: result.samples.length,
    errors: result.errors,
    rps: Number((result.samples.length / (result.wallMs / 1000)).toFixed(1)),
    min: Number((sorted[0] ?? 0).toFixed(2)),
    p50: Number(percentile(sorted, 50).toFixed(2)),
    p95: Number(percentile(sorted, 95).toFixed(2)),
    p99: Number(percentile(sorted, 99).toFixed(2)),
    max: Number((sorted[sorted.length - 1] ?? 0).toFixed(2)),
    mean: Number((total / (sorted.length || 1)).toFixed(2)),
    throughputKbs: Number((result.bytes / 1024 / (result.wallMs / 1000)).toFixed(1)),
  };
}

/**
 * Drive `fn` with fixed concurrency for `seconds`, discarding a warm-up
 * window first. Without the warm-up the first samples measure JIT compilation,
 * a cold connection pool and an empty page cache — which is a real cost, but
 * not the steady-state number anyone is trying to learn.
 */
async function drive(name: string, fn: () => Promise<number>, seconds: number): Promise<Result> {
  const samples: number[] = [];
  let errors = 0;
  let bytes = 0;
  let recording = false;

  const deadline = Date.now() + (WARMUP_S + seconds) * 1000;
  const recordFrom = Date.now() + WARMUP_S * 1000;
  let started = 0;

  const worker = async () => {
    while (Date.now() < deadline) {
      if (!recording && Date.now() >= recordFrom) {
        recording = true;
        started = performance.now();
      }
      const t0 = performance.now();
      try {
        const size = await fn();
        const elapsed = performance.now() - t0;
        if (recording) {
          samples.push(elapsed);
          bytes += size;
        }
      } catch {
        if (recording) errors += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { name, samples, errors, bytes, wallMs: performance.now() - started };
}

async function main(): Promise<void> {
  console.log(`Kairos benchmark`);
  console.log(`  target       ${BASE}`);
  console.log(`  concurrency  ${CONCURRENCY}`);
  console.log(`  duration     ${DURATION_S}s per case (after ${WARMUP_S}s warm-up)`);
  console.log('');

  // ---- authenticate ----
  const loginResponse = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!loginResponse.ok) {
    console.error(`Could not log in as ${EMAIL}. Run \`pnpm db:seed\` first, or set BENCH_EMAIL / BENCH_PASSWORD.`);
    process.exit(1);
  }
  const login = (await loginResponse.json()) as { data: { accessToken: string } };
  const auth = { authorization: `Bearer ${login.data.accessToken}` };

  const projectsResponse = await fetch(`${BASE}/api/v1/projects`, { headers: auth });
  const projects = (await projectsResponse.json()) as { data: { ref: string }[] };
  const ref = projects.data[0]?.ref;
  if (!ref) {
    console.error('No projects found. Create one, or run `pnpm db:seed`.');
    process.exit(1);
  }

  const keysResponse = await fetch(`${BASE}/api/v1/projects/${ref}/keys`, { headers: auth });
  const keys = (await keysResponse.json()) as { data: { kind: string; prefix: string }[] };
  const anonKey = process.env['BENCH_ANON_KEY'];
  if (!anonKey) {
    console.warn('BENCH_ANON_KEY not set — skipping the REST cases.');
    console.warn(`(keys on this project: ${keys.data?.map((k) => k.kind).join(', ') ?? 'none'})`);
  }

  const cases: { name: string; fn: () => Promise<number> }[] = [
    {
      // The floor. Anything slower than this on other routes is work, not
      // overhead — useful for separating framework cost from query cost.
      name: 'GET /api/health (no database)',
      fn: async () => {
        const r = await fetch(`${BASE}/api/health`);
        return (await r.text()).length;
      },
    },
    {
      name: 'GET /api/v1/projects (authenticated, 1 query)',
      fn: async () => {
        const r = await fetch(`${BASE}/api/v1/projects`, { headers: auth });
        if (!r.ok) throw new Error(String(r.status));
        return (await r.text()).length;
      },
    },
    {
      name: `GET /api/v1/projects/${ref}/database/tables (introspection)`,
      fn: async () => {
        const r = await fetch(`${BASE}/api/v1/projects/${ref}/database/tables`, { headers: auth });
        if (!r.ok) throw new Error(String(r.status));
        return (await r.text()).length;
      },
    },
    {
      name: 'POST /api/v1/projects/:ref/sql (SELECT 1)',
      fn: async () => {
        const r = await fetch(`${BASE}/api/v1/projects/${ref}/sql`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ query: 'SELECT 1' }),
        });
        if (!r.ok) throw new Error(String(r.status));
        return (await r.text()).length;
      },
    },
  ];

  if (anonKey) {
    cases.push({
      name: 'GET /rest/v1/profiles?limit=20 (auto REST, RLS on)',
      fn: async () => {
        const r = await fetch(`${BASE}/rest/v1/profiles?limit=20`, { headers: { apikey: anonKey } });
        if (!r.ok) throw new Error(String(r.status));
        return (await r.text()).length;
      },
    });
  }

  const summaries = [];
  for (const testCase of cases) {
    process.stdout.write(`  running: ${testCase.name} ... `);
    const result = await drive(testCase.name, testCase.fn, DURATION_S);
    const summary = summarise(result);
    summaries.push(summary);
    process.stdout.write(`${summary.requests} reqs, p95 ${summary.p95}ms\n`);
  }

  console.log('');
  console.log('  case                                                 rps      p50      p95      p99      max   err');
  console.log('  ' + '-'.repeat(100));
  for (const s of summaries) {
    const name = s.name.length > 48 ? s.name.slice(0, 45) + '...' : s.name.padEnd(48);
    console.log(
      `  ${name} ${String(s.rps).padStart(7)} ${String(s.p50).padStart(8)} ${String(s.p95).padStart(8)} ` +
        `${String(s.p99).padStart(8)} ${String(s.max).padStart(8)} ${String(s.errors).padStart(5)}`,
    );
  }

  console.log('');
  console.log('  Reading these numbers:');
  console.log('  - p99 far above p95 usually means checkpoint or autovacuum stalls, not slow queries.');
  console.log('  - If /api/health is itself slow, the bottleneck is the event loop or the proxy, not PostgreSQL.');
  console.log('  - Over a Cloudflare Tunnel, network round-trip dominates and no amount of database');
  console.log('    tuning will move p50. Benchmark on the LAN to see what the server can actually do.');
  console.log('  - Re-run after scripts/tune-postgres.sh to see whether the tuning helped. Often it does not,');
  console.log('    and knowing that is worth more than assuming it did.');

  if (process.env['BENCH_JSON']) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(process.env['BENCH_JSON'], JSON.stringify(summaries, null, 2));
    console.log(`\n  Wrote ${process.env['BENCH_JSON']}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
