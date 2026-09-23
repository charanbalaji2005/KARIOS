/**
 * Server identity.
 *
 * An installation needs a name that is stable across reboots, hostname changes
 * and DHCP leases, and that is not guessable from anything public. The hostname
 * is none of those things — `ubuntu-laptop` is the identity of roughly a
 * million machines — so the agent mints an Ed25519 keypair once and derives the
 * server id from the public half.
 *
 * The private key is written to /etc/kairos/server-key.pem with mode 0600 and
 * is never returned by any operation. There is deliberately no `get private
 * key` code path to be tricked into.
 */
import { generateKeyPairSync, createPublicKey, createHash, sign as signBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { register } from '../registry.js';
import { config } from '../config.js';
import { log } from '../log.js';

const PRIVATE_KEY_PATH = join(config.configRoot, 'server-key.pem');
const PUBLIC_KEY_PATH = join(config.configRoot, 'server-key.pub');

export interface ServerIdentity {
  serverId: string;
  publicKey: string;
  createdAt: string;
  hostname: string;
}

let cached: { identity: ServerIdentity; privateKeyPem: string } | null = null;

/**
 * The id is the first 16 hex characters of the SHA-256 of the public key.
 *
 * Deriving it rather than generating a second random value means the id and
 * the key can never drift apart: anyone holding the public key can recompute
 * the id and check it matches.
 */
function deriveServerId(publicKeyPem: string): string {
  const digest = createHash('sha256').update(publicKeyPem).digest('hex');
  return `srv_${digest.slice(0, 16)}`;
}

export async function ensureIdentity(): Promise<ServerIdentity> {
  if (cached) return cached.identity;

  try {
    const privateKeyPem = await readFile(PRIVATE_KEY_PATH, 'utf8');
    const publicKeyPem = createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString();
    const identity: ServerIdentity = {
      serverId: deriveServerId(publicKeyPem),
      publicKey: publicKeyPem,
      createdAt: (await readFile(PUBLIC_KEY_PATH, 'utf8').then(() => null).catch(() => null)) ?? new Date().toISOString(),
      hostname: hostname(),
    };
    cached = { identity, privateKeyPem };
    return identity;
  } catch {
    // No key yet — first boot.
  }

  log.info('generating server identity');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  await mkdir(config.configRoot, { recursive: true, mode: 0o750 });
  await writeFile(PRIVATE_KEY_PATH, privateKeyPem, { mode: 0o600 });
  // writeFile's mode is masked by the umask, so state it again.
  await chmod(PRIVATE_KEY_PATH, 0o600);
  await writeFile(PUBLIC_KEY_PATH, publicKeyPem, { mode: 0o644 });

  const identity: ServerIdentity = {
    serverId: deriveServerId(publicKeyPem),
    publicKey: publicKeyPem,
    createdAt: new Date().toISOString(),
    hostname: hostname(),
  };
  cached = { identity, privateKeyPem };
  log.info('server identity created', { serverId: identity.serverId });
  return identity;
}

/**
 * Sign a challenge with the server key.
 *
 * This is what lets a client device confirm it is talking to the server it
 * enrolled with rather than to something that answered on the same address.
 */
export async function signChallenge(challenge: string): Promise<string> {
  await ensureIdentity();
  const privateKeyPem = cached!.privateKeyPem;
  return signBytes(null, Buffer.from(challenge, 'utf8'), privateKeyPem).toString('base64');
}

register(
  {
    id: 'server_identity',
    summary: 'This installation\'s server id and public key',
    category: 'system',
    danger: false,
    timeoutMs: 15_000,
    async run() {
      const identity = await ensureIdentity();
      return {
        data: identity,
        text: [
          `Server id    ${identity.serverId}`,
          `Hostname     ${identity.hostname}`,
          `Created      ${identity.createdAt}`,
          '',
          'Public key:',
          identity.publicKey.trim(),
          '',
          `The private key stays in ${PRIVATE_KEY_PATH} (mode 0600) and is never returned by any operation.`,
        ].join('\n'),
      };
    },
  },
  {
    id: 'server_sign_challenge',
    summary: 'Sign a challenge string, proving this is the same server',
    category: 'system',
    danger: false,
    timeoutMs: 15_000,
    args: {
      challenge: {
        type: 'string',
        // Base64url-ish: a nonce, not a message. Keeping it to an opaque token
        // means this cannot be used as a general-purpose signing oracle for
        // structured data someone else will parse.
        pattern: /^[A-Za-z0-9_-]{16,128}$/,
        maxLength: 128,
        required: true,
      },
    },
    async run({ args }) {
      const signature = await signChallenge(String(args['challenge']));
      const identity = await ensureIdentity();
      return {
        data: { serverId: identity.serverId, signature, algorithm: 'ed25519' },
        text: signature,
      };
    },
  },
);
