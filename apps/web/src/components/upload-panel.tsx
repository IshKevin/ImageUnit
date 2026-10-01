'use client';

import clsx from 'clsx';
import { CheckCircle2, ImagePlus, RotateCcw, Video, UploadCloud, X, XCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { ACCEPT_ATTR, isVideoFile, useUploader } from '@/lib/uploader';
import { bytes } from '@/lib/format';
import { Button, Card, Progress, Spinner } from './ui';

export function UploadPanel({ eventId, galleryId, onSettled, disabled }: { eventId: string; galleryId?: string; onSettled: () => void; disabled?: boolean }) {
  const u = useUploader(eventId, galleryId, onSettled);
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  const add = (files: FileList | null) => {
    if (!files?.length) return;
    u.addFiles([...files]);
    setTimeout(() => void u.start(), 0);
  };
  const pct = u.counts.total ? ((u.counts.done + u.counts.failed) / u.counts.total) * 100 : 0;
  const visible = u.items.filter((i) => i.status !== 'done').slice(0, 50);

  return (
    <Card className="p-5">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (!disabled) add(e.dataTransfer.files);
        }}
        className={clsx('flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors', drag ? 'border-accent bg-accent/5' : 'border-border', disabled && 'opacity-50')}
      >
        <UploadCloud className="size-8 text-muted" aria-hidden />
        <div>
          <p className="font-medium">Drag photos and videos here</p>
          <p className="text-sm text-muted">JPEG, PNG, WebP, TIFF, AVIF, MP4, MOV, WebM or MKV</p>
          <p className="text-sm text-muted">Photos up to 100 MB · videos up to 2 GB</p>
        </div>
        <input ref={input} type="file" multiple accept={ACCEPT_ATTR} aria-label="Choose photos or videos" hidden onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
        <Button variant="primary" onClick={() => input.current?.click()} disabled={disabled}>
          <ImagePlus className="size-4" /> Choose files
        </Button>
        <p className="text-xs text-muted">Videos are converted in the background after upload — this can take a few minutes</p>
        {disabled && <p className="text-xs text-muted">Uploads are closed for this event.</p>}
      </div>

      {u.counts.total > 0 && (
        <div className="mt-5 space-y-3" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <p className="tabular-nums">
              <strong>{(u.counts.done + u.counts.failed).toLocaleString()}</strong> / {u.counts.total.toLocaleString()} · Completed {u.counts.done.toLocaleString()} · <span className={u.counts.failed ? 'text-danger' : ''}>Failed {u.counts.failed}</span> · Remaining {u.counts.remaining.toLocaleString()}
            </p>
            <div className="flex gap-2">
              {u.counts.failed > 0 && !u.inFlight && (
                <Button size="sm" onClick={() => void u.retryFailed()}>
                  <RotateCcw className="size-3.5" /> Retry failed
                </Button>
              )}
              {u.inFlight && <Button size="sm" onClick={u.cancel}>Cancel</Button>}
              {!u.inFlight && u.counts.done > 0 && <Button size="sm" variant="ghost" onClick={u.clearDone}>Clear completed</Button>}
            </div>
          </div>
          <Progress value={pct} tone={u.counts.failed && !u.inFlight ? 'warning' : 'accent'} />
          {visible.length > 0 && (
            <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border text-sm">
              {visible.map((i) => (
                <li key={i.id} className="flex items-center gap-3 px-3 py-2">
                  {i.status === 'failed' ? <XCircle className="size-4 shrink-0 text-danger" /> : i.status === 'done' ? <CheckCircle2 className="size-4 shrink-0 text-success" /> : i.status === 'queued' ? <X className="size-4 shrink-0 opacity-0" /> : <Spinner className="size-4" />}
                  {isVideoFile(i.file) && <Video className="size-4 shrink-0 text-muted" aria-label="Video" />}
                  <span className="min-w-0 flex-1 truncate">{i.file.name}</span>
                  {i.status === 'failed' ? <span className="truncate text-xs text-danger">{i.error}</span> : i.status === 'uploading' ? <span className="w-12 text-right text-xs tabular-nums text-muted">{Math.round(i.progress * 100)}%</span> : <span className="text-xs text-muted">{i.status === 'queued' ? bytes(i.file.size) : i.status}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
