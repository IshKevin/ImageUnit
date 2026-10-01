export function bytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export const num = (n: number | null | undefined) => (n ?? 0).toLocaleString();

export function date(d: string | Date | null | undefined, withTime = false): string {
  if (!d) return '—';
  return new Date(d).toLocaleString(undefined, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}

export function relative(d: string | Date): string {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  const abs = Math.abs(s);
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60) return fmt.format(-Math.round(s), 'second');
  if (abs < 3600) return fmt.format(-Math.round(s / 60), 'minute');
  if (abs < 86400) return fmt.format(-Math.round(s / 3600), 'hour');
  return fmt.format(-Math.round(s / 86400), 'day');
}

export const label = (s: string) => s.replace(/[_:.]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** `<input type="datetime-local">` value from an ISO string, in local time. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/** 83 -> "1:23", 3725 -> "1:02:05" */
export function duration(seconds: number | null | undefined): string {
  if (!seconds || seconds < 0) return '0:00';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** What to show for an item's name: the editor's title, or the file name without its extension. */
export const displayName = (m: { title: string | null; filename: string }) => m.title?.trim() || m.filename.replace(/\.[^.]+$/, '');
