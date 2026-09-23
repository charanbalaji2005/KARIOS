import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../env.js';
import { ApiError } from './errors.js';

const accessKey = new TextEncoder().encode(env.JWT_SECRET);
const ISSUER = 'kairosdb';

export interface AccessClaims extends JWTPayload {
  sub: string;
  email: string;
  typ: 'dashboard';
}

/** Tokens minted for the dashboard/API of the control plane. */
export async function signAccessToken(userId: string, email: string): Promise<string> {
  return new SignJWT({ email, typ: 'dashboard' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(env.ACCESS_TOKEN_TTL)
    .sign(accessKey);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, accessKey, { issuer: ISSUER });
    return payload as AccessClaims;
  } catch {
    throw new ApiError('INVALID_TOKEN', 'Your session has expired. Sign in again.');
  }
}

/**
 * Tokens minted for *end users of a project* — signed with that project's own
 * secret, so one project can never mint a token another project will accept.
 */
export interface ProjectClaims extends JWTPayload {
  sub: string;
  role: string;
  project_ref: string;
}

export async function signProjectToken(
  projectSecret: string,
  projectRef: string,
  subject: string,
  role: string,
  ttl = '1h',
): Promise<string> {
  return new SignJWT({ role, project_ref: projectRef })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(subject)
    .setIssuer(`kairosdb:${projectRef}`)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(new TextEncoder().encode(projectSecret));
}

export async function verifyProjectToken(
  projectSecret: string,
  projectRef: string,
  token: string,
): Promise<ProjectClaims> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(projectSecret), {
      issuer: `kairosdb:${projectRef}`,
    });
    return payload as ProjectClaims;
  } catch {
    throw new ApiError('INVALID_TOKEN', 'Invalid or expired project token');
  }
}
