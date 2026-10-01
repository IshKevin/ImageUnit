'use client';

import { Card, EmptyState, Loading, PageHeader } from '@/components/ui';
import { MediaBrowser } from '@/components/media-browser';
import { can, useMe } from '@/lib/auth';

export default function LibraryPage() {
  const { data: user, isLoading } = useMe();
  if (isLoading) return <Loading />;
  if (!can(user, 'events:view')) {
    return <Card><EmptyState title="You don't have access to the library" /></Card>;
  }
  return (
    <>
      <PageHeader title="Library" description="All photographs and videos across events" />
      <MediaBrowser mode="manage" />
    </>
  );
}
