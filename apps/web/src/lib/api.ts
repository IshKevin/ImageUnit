export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...rest,
    headers: { ...(json !== undefined && { 'content-type': 'application/json' }), ...headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return data as T;
}

export const get = <T,>(path: string) => api<T>(path);
export const post = <T,>(path: string, json: unknown = {}) => api<T>(path, { method: 'POST', json });
export const patch = <T,>(path: string, json: unknown) => api<T>(path, { method: 'PATCH', json });
export const put = <T,>(path: string, json: unknown) => api<T>(path, { method: 'PUT', json });
export const del = <T,>(path: string) => api<T>(path, { method: 'DELETE' });

export const qs = (params: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
};

// ---- shared types (mirror the API DTOs) ----
export type Role = 'admin' | 'photographer';
export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: 'active' | 'suspended' | 'inactive';
  permissions: string[];
  grantedPermissions: string[];
  revokedPermissions: string[];
  storageQuotaBytes: number | null;
  lastLoginAt: string | null;
  createdAt: string;
}
export type EventStatus = 'draft' | 'active' | 'expired' | 'archived' | 'scheduled_for_deletion';
export type DownloadPolicy = 'disabled' | 'preview' | 'full';
export interface EventItem {
  id: string;
  ownerId: string;
  ownerName?: string;
  slug: string;
  name: string;
  description: string;
  eventDate: string | null;
  location: string | null;
  status: EventStatus;
  visibility: 'public' | 'unlisted' | 'private';
  downloadPolicy: DownloadPolicy;
  hasPassword: boolean;
  expiresAt: string | null;
  publishedAt: string | null;
  archivedAt: string | null;
  retentionReviewAt: string | null;
  coverPhotoId: string | null;
  shareUrl: string;
  isPubliclyAvailable: boolean;
  photoCount?: number;
  readyCount?: number;
  storageBytes?: number;
  createdAt: string;
}
export interface Gallery {
  id: string;
  eventId: string;
  name: string;
  description: string;
  isVisible: boolean;
  downloadPolicy: DownloadPolicy | null;
  sortOrder: number;
  photoCount: number;
  readyCount: number;
}
export type PhotoStatus = 'pending_upload' | 'uploaded' | 'processing' | 'ready' | 'failed';
export interface Photo {
  id: string;
  galleryId: string | null;
  filename: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  status: PhotoStatus;
  error: string | null;
  isHidden: boolean;
  thumbUrl: string | null;
  previewUrl: string | null;
  createdAt: string;
}
export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
