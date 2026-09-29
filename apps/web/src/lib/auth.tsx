'use client';

import { useQuery } from '@tanstack/react-query';
import { ApiError, get, type User } from './api';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => (await get<{ user: User }>('/auth/me')).user,
    retry: false,
    staleTime: 60_000,
  });
}

export const unauthenticated = (e: unknown) => e instanceof ApiError && e.status === 401;

export const can = (user: User | undefined, perm: string) => !!user && user.permissions.includes(perm);
