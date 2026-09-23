/**
 * Load test.
 *
 * The latency benchmark answers "how fast is one request when nothing else is
 * happening". This answers the more useful question: **where does it break?**
 *
 * It steps concurrency up through a ladder and records, at each step, whether
 * throughput is still rising. The point at which throughput stops rising while
 * latency keeps climbing is the saturation point — the number that actually
 * matters for a machine you can carry, and one that a fixed-concurrency
 * benchmark cannot find.
 *
 *   pnpm --filter @kairosdb/tests exec tsx benchmark/load.bench.ts
 *   LOAD_STAGES=1,10,50,100,250 LOAD_DURATION=20 pnpm ... load.bench.ts
 */
import { performance } from 'node:perf_hooks';

const BASE = process.env['BENCH_URL'] ?? 'http://localhost:4000';
const EMAIL = process.env['BENCH_EMAIL'] ?? 'dev@kairosdb.local';
const PASSWORD = process.env['BENCH_PASSWORD'] ?? 'kairosdb-dev-password';
const STAGES = (process.env['LOAD_STAGES'] ?? '1,10,25,50,100,200')
  .split(',')
  .map((entry) => Number(entry.trim()))
  .filter((entry) => Number.isFinite(entry) && entry > 0);
const DURATION_S = Number(process.env['LOAD_DURATION'] ?? 15);
const COOLDOWN_MS = Number(process.env['LOAD_COOLDOWN'] ?? 3000);

interface StageResult {
  concurrency: number;
  requests: number;
  errors: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  serverCpu?: number | undefined;
  serverMemory?: number | undefined;
  poolWaiting?: number | undefined;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number((sorted[Math.max(0, index)] ?? 0).toFixed(2));
}

async function runStage(
  concurrency: number,
  work: () => Promise<void>,
  auth: Record<string, string>,
): Promise<StageResult> {
  const samples: number[] = [];
  let errors = 0;
  const deadline = Date.now() + DURATION_S * 1000;
  const started = performance.now();

  const worker = async () => {
    while (Date.now() < deadline) {
      const t0 = performance.now();
      try {
        await work();
        samples.push(performance.now() - t0);
      } catch {
        errors += 1;
      }
    }
  };

  // Sample the server mid-stage rather than after. Afterwards the machine has
  // already recovered and the reading describes an idle box.
  let serverSnapshot: { cpu?: number; memory?: number; waiting?: number } = {};
  const sampler = setTimeout(() => {
    void fetch(`${BASE}/api/v1/server/metrics`, { headers: auth })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { data?: { cpu?: { usagePercent: number }; memory?: { usedPercent: number } } } | null) => {
        serverSnapshot = {
          cpu: body?.data?.cpu?.usagePercent,
          memory: body?.data?.memory?.usedPercent,
        };
      })
      .catch(() => undefined);
  }, (DURATION_S * 1000) / 2);

  await Promise.all(Array.from({ length: concurrency }, worker));
  clearTimeout(sampler);

  const elapsed = (performance.now() - started) / 1000;
  const sorted = [...samples].sort((a, b) => a - b);

  return {
    concurrency,
    requests: samples.length,
    errors,
    rps: Number((samples.length / elapsed).toFixed(1)),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: Number((sorted[sorted.length - 1] ?? 0).toFixed(2)),
    serverCpu: serverSnapshot.cpu,
    serverMemory: serverSnapshot.memory,
    poolWaiting: serverSnapshot.waiting,
  };
}

async function main(): Promise<void> {
  const loginResponse = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!loginResponse.ok) {
    console.error(`Could not log in as ${EMAIL}. Run \`pnpm db:seed\` first.`);
    process.exit(1);
  }
  const login = (await loginResponse.json()) as { data: { accessToken: string } };
  const auth = { authorization: `Bearer ${login.data.accessToken}` };

  const projects = (await (await fetch(`${BASE}/api/v1/projects`, { headers: auth })).json()) as {
    data: { ref: string }[];
  };
  const ref = projects.data[0]?.ref;
  if (!ref) {
    console.error('No projects found. Run `pnpm db:seed`.');
    process.exit(1);
  }

  const scenarios: { name: string; work: () => Promise<void> }[] = [
    {
      name: 'read (authenticated, 1 query)',
      work: async () => {
        const response = await fetch(`${BASE}/api/v1/projects`, { headers: auth });
        if (!response.ok) throw new Error(String(response.status));
        await response.text();
      },
    },
    {
      name: 'sql (SELECT 1)',
      work: async () => {
        const response = await fetch(`${BASE}/api/v1/projects/${ref}/sql`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ query: 'SELECT 1' }),
        });
        if (!response.ok) throw new Error(String(response.status));
        await response.text();
      },
    },
  ];

  for (const scenario of scenarios) {
    console.log(`\n${scenario.name}`);
    console.log('  conc     rps      p50      p95      p99      max   err   cpu%   mem%');
    console.log('  ' + '-'.repeat(74));

    const results: StageResult[] = [];
    let saturated: number | null = null;

    for (const concurrency of STAGES) {
      const result = await runStage(concurrency, scenario.work, auth);
      results.push(result);

      console.log(
        `  ${String(result.concurrency).padStart(4)} ${String(result.rps).padStart(7)} ` +
          `${String(result.p50).padStart(8)} ${String(result.p95).padStart(8)} ${String(result.p99).padStart(8)} ` +
          `${String(result.max).padStart(8)} ${String(result.errors).padStart(5)} ` +
          `${String(result.serverCpu ?? '-').padStart(6)} ${String(result.serverMemory ?? '-').padStart(6)}`,
      );

      // Saturation: throughput has stopped rising meaningfully while latency
      // continues to climb. Past this point, more concurrency buys queueing,
      // not work.
      const previous = results[results.length - 2];
      if (saturated === null && previous && result.rps < previous.rps * 1.05 && result.p95 > previous.p95 * 1.3) {
        saturated = previous.concurrency;
      }

      // Let the machine settle so the next stage does not inherit this one's
      // queue depth and get blamed for it.
      await new Promise((resolve) => setTimeout(resolve, COOLDOWN_MS));
    }

    const peak = results.reduce((best, entry) => (entry.rps > best.rps ? entry : best), results[0]!);
    console.log('');
    console.log(`  peak throughput   ${peak.rps} rps at concurrency ${peak.concurrency} (p95 ${peak.p95}ms)`);
    if (saturated !== null) {
      console.log(`  saturates around  concurrency ${saturated} — past here you are buying queue, not throughput`);
    } else {
      console.log('  no saturation point found — raise LOAD_STAGES to push harder');
    }
    const errored = results.filter((entry) => entry.errors > 0);
    if (errored.length > 0) {
      console.log(`  errors appear at  concurrency ${errored[0]!.concurrency} (${errored[0]!.errors} failed)`);
      console.log('  check kairos_pg_clients_waiting — this is usually the connection budget, not the database');
    }
  }

  console.log('');
  console.log('  Reading this:');
  console.log('  - p99 climbing while rps is flat means queueing, not slow queries.');
  console.log('  - Errors at high concurrency are usually the connection budget doing its job.');
  console.log('    That is the intended behaviour: refuse one project rather than exhaust the machine.');
  console.log('  - Run it against the LAN address, not through a tunnel, to measure the server rather');
  console.log('    than the internet between you and it.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
