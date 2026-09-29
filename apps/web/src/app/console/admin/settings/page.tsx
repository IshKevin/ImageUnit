'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button, Card, ErrorNote, Field, Input, Loading, PageHeader } from '@/components/ui';
import { get, put } from '@/lib/api';
import { AdminGate } from '../_shared';

interface Settings {
  defaultAccessDays: number;
  archiveRetentionMonths: number;
  expiryWarningDays: number;
  storageAlertPercent: number;
  quotaAlertPercent: number;
}
type Key = keyof Settings;

const FIELDS: { key: Key; label: string; hint: string; min: number; max: number }[] = [
  { key: 'defaultAccessDays', label: 'Default access days', hint: 'Days a newly published event stays publicly accessible.', min: 1, max: 3650 },
  { key: 'archiveRetentionMonths', label: 'Archive retention (months)', hint: 'Months an archived event is kept before it is flagged for deletion review.', min: 1, max: 240 },
  { key: 'expiryWarningDays', label: 'Expiry warning (days)', hint: 'Days before expiry that photographers are warned.', min: 1, max: 90 },
  { key: 'storageAlertPercent', label: 'Storage alert (%)', hint: 'Percentage of total storage at which administrators are alerted.', min: 50, max: 99 },
  { key: 'quotaAlertPercent', label: 'Quota alert (%)', hint: 'Percentage of a photographer quota at which they are alerted.', min: 50, max: 99 },
];

export default function SettingsPage() {
  return (
    <AdminGate perm="settings:manage">
      <SettingsForm />
    </AdminGate>
  );
}

function SettingsForm() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-settings'], queryFn: async () => (await get<{ settings: Settings }>('/admin/settings')).settings });
  const [v, setV] = useState<Record<Key, string> | null>(null);
  useEffect(() => {
    if (q.data) setV(Object.fromEntries(FIELDS.map((f) => [f.key, String(q.data[f.key])])) as Record<Key, string>);
  }, [q.data]);

  const errors: Partial<Record<Key, string>> = {};
  if (v) for (const f of FIELDS) {
    const n = Number(v[f.key]);
    if (v[f.key].trim() === '' || !Number.isInteger(n) || n < f.min || n > f.max) errors[f.key] = `Enter a whole number from ${f.min} to ${f.max}.`;
  }
  const valid = Object.keys(errors).length === 0;

  const save = useMutation({
    mutationFn: () => put<{ settings: Settings }>('/admin/settings', Object.fromEntries(FIELDS.map((f) => [f.key, Number(v![f.key])]))),
    onSuccess: (r) => { toast.success('Settings saved'); qc.setQueryData(['admin-settings'], r.settings); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save settings'),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); if (valid) save.mutate(); };

  return (
    <div>
      <PageHeader title="Settings" description="Platform-wide defaults and alert thresholds." />
      {q.isLoading || (!v && !q.error) ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : v && (
        <Card className="max-w-2xl">
          <form onSubmit={submit} className="space-y-5 p-5">
            {FIELDS.map((f) => (
              <Field key={f.key} label={f.label} hint={`${f.hint} Range ${f.min} to ${f.max}.`} error={errors[f.key]}>
                <Input type="number" inputMode="numeric" min={f.min} max={f.max} step={1} value={v[f.key]} aria-invalid={!!errors[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
              </Field>
            ))}
            <div className="flex justify-end">
              <Button type="submit" variant="primary" loading={save.isPending} disabled={!valid}>Save settings</Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
