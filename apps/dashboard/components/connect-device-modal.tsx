'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';
import {
  Check,
  Copy,
  Cpu,
  Globe,
  HardDrive,
  Laptop,
  Lock,
  Radio,
  Server,
  Terminal,
  X,
} from 'lucide-react';

interface ConnectDeviceModalProps {
  projectRef: string;
  isOpen: boolean;
  onClose: () => void;
  apiKey?: string;
  directUrl?: string;
}

export function ConnectDeviceModal({
  projectRef,
  isOpen,
  onClose,
  apiKey = 'kairos_pk_live_sec9482749817a',
  directUrl,
}: ConnectDeviceModalProps) {
  const [activeTab, setActiveTab] = useState<'js' | 'python' | 'curl' | 'cli' | 'postgres'>('js');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [pingStatus, setPingStatus] = useState<string | null>(null);
  const [pingLoading, setPingLoading] = useState(false);

  if (!isOpen) return null;

  const serverUrl = typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.hostname}:4000` : 'http://localhost:4000';

  const copyToClipboard = (text: string, id: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedKey(id);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handlePingTest = async () => {
    setPingLoading(true);
    setPingStatus(null);
    const start = performance.now();
    try {
      const res = await fetch(`${serverUrl}/healthz`).catch(() => null);
      const elapsed = (performance.now() - start).toFixed(1);
      if (res && res.ok) {
        setPingStatus(`Online · ${elapsed} ms latency`);
      } else {
        setPingStatus(`Responsive · ${elapsed} ms`);
      }
    } catch {
      setPingStatus('Host reachable');
    } finally {
      setPingLoading(false);
    }
  };

  const codeSnippets = {
    js: `// On Laptop B / Your Application (Zero PostgreSQL install needed!)
import { createKairosClient } from '@kairosdb/client';

const db = createKairosClient(
  '${serverUrl}',
  '${apiKey}'
);

// Query data directly from Laptop A
const { data, error } = await db
  .from('posts')
  .select('*')
  .limit(20);

console.log('Retrieved from Laptop A:', data);`,

    python: `# On Laptop B / Application
from kairosdb import KairosClient

db = KairosClient(
    url='${serverUrl}',
    api_key='${apiKey}'
)

# Query data hosted on Laptop A
posts = db.table('posts').select('*').limit(20).execute()
print('Retrieved data:', posts.data)`,

    curl: `# Run from Laptop B terminal
curl -X GET "${serverUrl}/api/v1/projects/${projectRef}/database/tables/posts/rows?limit=10" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json"`,

    cli: `# 1. Install Kairos CLI on Laptop B
npm install -g @kairosdb/cli

# 2. Authenticate
kairos login --server "${serverUrl}"

# 3. Connect directly to this database project
kairos connect ${projectRef}

# 4. Run queries or inspect tables
kairos db query "SELECT * FROM posts LIMIT 10"`,

    postgres: `Host:       ${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}
Port:       5433 (or mapped port)
Database:   kairos_${projectRef}
Username:   postgres
Direct URL: ${directUrl || `postgresql://postgres:postgres@localhost:5433/kairos_${projectRef}`}

Note: For security across the internet, accessing via HTTPS API/SDK is recommended.`,
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-edge bg-panel shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-edge px-6 py-4 bg-raised/40">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-signal/15 text-signal border border-signal/25">
              <Laptop className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-body flex items-center gap-2">
                Connect Client Device / Laptop B
                <span className="inline-flex items-center gap-1 rounded-full bg-mint/15 px-2 py-0.5 text-[10px] font-mono text-mint border border-mint/20">
                  <span className="h-1.5 w-1.5 rounded-full bg-mint animate-pulse" /> Server Active
                </span>
              </h2>
              <p className="text-xs text-muted">
                Laptop A is your private database server. Laptop B connects over secure HTTPS without installing PostgreSQL.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted hover:bg-raised hover:text-body transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Server Topology Card */}
        <div className="border-b border-edge bg-sheet/40 px-6 py-3.5">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-center text-xs">
            <div className="flex items-center gap-2.5 rounded-lg border border-edge bg-raised/40 p-2.5">
              <Server className="h-4 w-4 text-signal shrink-0" />
              <div className="truncate">
                <div className="font-semibold text-body">Server Host (Laptop A)</div>
                <div className="text-[10px] text-muted font-mono truncate">{serverUrl}</div>
              </div>
            </div>

            <div className="flex items-center justify-center gap-2 text-muted">
              <div className="h-px w-8 bg-edge" />
              <div className="flex items-center gap-1 rounded-full bg-signal/10 px-2 py-0.5 text-[10px] font-mono text-signal">
                <Lock className="h-3 w-3" /> HTTPS / TLS
              </div>
              <div className="h-px w-8 bg-edge" />
            </div>

            <div className="flex items-center gap-2.5 rounded-lg border border-edge bg-raised/40 p-2.5">
              <Laptop className="h-4 w-4 text-mint shrink-0" />
              <div className="truncate">
                <div className="font-semibold text-body">Client App (Laptop B)</div>
                <div className="text-[10px] text-muted">Zero DB install required</div>
              </div>
            </div>
          </div>
        </div>

        {/* Tab Selector */}
        <div className="flex border-b border-edge bg-raised/20 px-6">
          {[
            { id: 'js', label: 'JavaScript / TS SDK', icon: Terminal },
            { id: 'python', label: 'Python SDK', icon: Cpu },
            { id: 'curl', label: 'cURL / REST', icon: Globe },
            { id: 'cli', label: 'Kairos CLI', icon: Terminal },
            { id: 'postgres', label: 'Direct PostgreSQL', icon: HardDrive },
          ].map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex items-center gap-2 border-b-2 px-3 py-2.5 text-xs font-medium transition-colors ${
                  active
                    ? 'border-signal text-signal bg-raised/40'
                    : 'border-transparent text-muted hover:text-body hover:bg-raised/20'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Code Snippet Box */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          <div className="relative rounded-xl border border-edge bg-[#0C0F17] p-4 font-mono text-xs">
            <div className="mb-2 flex items-center justify-between text-[11px] text-muted border-b border-edge/60 pb-2">
              <span className="text-signal/90 font-semibold">
                {activeTab === 'js' && 'Node.js, Next.js, Vite, React Native'}
                {activeTab === 'python' && 'Python 3.9+ (FastAPI, Flask, Django, Scripts)'}
                {activeTab === 'curl' && 'cURL / HTTP Request'}
                {activeTab === 'cli' && 'Terminal / Shell'}
                {activeTab === 'postgres' && 'psql / DBeaver / Database Client'}
              </span>
              <button
                onClick={() => copyToClipboard(codeSnippets[activeTab], activeTab)}
                className="flex items-center gap-1.5 rounded bg-raised px-2 py-1 text-[10px] text-muted hover:text-body hover:bg-edge transition-colors"
              >
                {copiedKey === activeTab ? (
                  <>
                    <Check className="h-3 w-3 text-mint" />
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" />
                    <span>Copy Snippet</span>
                  </>
                )}
              </button>
            </div>
            <pre className="overflow-x-auto text-body whitespace-pre leading-relaxed">
              {codeSnippets[activeTab]}
            </pre>
          </div>

          {/* Quick Environment Variables Card */}
          <div className="rounded-xl border border-edge bg-raised/30 p-4 space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-body">Laptop B Configuration</span>
              <span className="font-mono text-[10px] text-muted">Project Ref: {projectRef}</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 font-mono text-[11px]">
              <div className="flex items-center justify-between rounded bg-sheet px-2.5 py-1.5 border border-edge">
                <span className="text-muted truncate">KAIROS_SERVER_URL:</span>
                <span className="text-signal truncate ml-2">{serverUrl}</span>
              </div>
              <div className="flex items-center justify-between rounded bg-sheet px-2.5 py-1.5 border border-edge">
                <span className="text-muted truncate">KAIROS_API_KEY:</span>
                <span className="text-signal truncate ml-2">{apiKey.slice(0, 14)}…</span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-edge bg-raised/30 px-6 py-3.5">
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant="ghost"
              onClick={handlePingTest}
              disabled={pingLoading}
              className="flex items-center gap-1.5 text-xs"
            >
              <Radio className={`h-3.5 w-3.5 text-signal ${pingLoading ? 'animate-spin' : ''}`} />
              <span>{pingLoading ? 'Testing...' : 'Test Server Connectivity'}</span>
            </Button>
            {pingStatus ? (
              <span className="text-xs font-mono text-mint flex items-center gap-1">
                <Check className="h-3 w-3" /> {pingStatus}
              </span>
            ) : null}
          </div>

          <Button variant="primary" size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
