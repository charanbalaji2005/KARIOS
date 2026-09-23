import { ApiError } from './errors.js';

export type Role = 'owner' | 'admin' | 'developer' | 'viewer';

export const PERMISSIONS = [
  'project.read', 'project.write', 'project.delete',
  'database.read', 'database.write', 'database.admin',
  'storage.read', 'storage.write', 'storage.admin',
  'members.read', 'members.write',
  'settings.read', 'settings.write',
  'keys.read', 'keys.write',
  'logs.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: Permission[] = ['project.read', 'database.read', 'storage.read', 'members.read', 'settings.read', 'logs.read'];
const DEVELOPER: Permission[] = [...VIEWER, 'database.write', 'storage.write', 'keys.read'];
const ADMIN: Permission[] = [...DEVELOPER, 'project.write', 'database.admin', 'storage.admin', 'members.write', 'settings.write', 'keys.write'];
const OWNER: Permission[] = [...ADMIN, 'project.delete'];

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set(VIEWER),
  developer: new Set(DEVELOPER),
  admin: new Set(ADMIN),
  owner: new Set(OWNER),
};

export const can = (role: Role, permission: Permission): boolean => MATRIX[role].has(permission);

export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) {
    throw new ApiError('FORBIDDEN', `Your role (${role}) cannot perform ${permission}`);
  }
}
