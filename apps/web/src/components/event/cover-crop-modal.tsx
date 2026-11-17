'use client';

import { useMutation } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { toast } from 'sonner';
import { Button, ErrorNote, Modal } from '../ui';
import { put, type CoverCrop, type EventItem } from '@/lib/api';

const ASPECTS = [
  { id: '16:9', label: '16:9', value: 16 / 9 },
  { id: '3:2', label: '3:2', value: 3 / 2 },
  { id: '4:3', label: '4:3', value: 4 / 3 },
  { id: '1:1', label: 'Square', value: 1 },
  { id: 'free', label: 'Free', value: null },
] as const;
type AspectId = (typeof ASPECTS)[number]['id'];

const MIN = 0.05; // smallest crop edge, as a fraction of the image
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Largest box of the given pixel aspect that keeps the current centre (and roughly the current width). */
function fitAspect(c: CoverCrop, aspect: number | null, imgRatio: number): CoverCrop {
  if (!aspect) return c;
  const cx = c.x + c.width / 2;
  const cy = c.y + c.height / 2;
  let w = c.width;
  let h = (w * imgRatio) / aspect;
  if (h > 1) { h = 1; w = (h * aspect) / imgRatio; }
  if (w > 1) { w = 1; h = (w * imgRatio) / aspect; }
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), width: w, height: h };
}

function matchAspect(c: CoverCrop, imgRatio: number): AspectId {
  const r = (c.width / c.height) * imgRatio;
  return ASPECTS.find((a) => a.value && Math.abs(a.value - r) / a.value < 0.02)?.id ?? 'free';
}

type Drag = { mode: 'move'; startX: number; startY: number; start: CoverCrop } | { mode: 'resize'; ax: number; ay: number };

export function CoverCropModal({ event, open, onClose, onSaved }: { event: EventItem; open: boolean; onClose: () => void; onSaved: () => void }) {
  const source = event.coverSource;
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [imgRatio, setImgRatio] = useState<number | null>(source?.width && source.height ? source.width / source.height : null);
  const [aspect, setAspect] = useState<AspectId>('16:9');
  const [crop, setCrop] = useState<CoverCrop>({ x: 0, y: 0, width: 1, height: 1 });

  // Start from the saved crop when it belongs to this photo, otherwise the largest centred 16:9 box.
  useEffect(() => {
    if (!open || !imgRatio) return;
    const saved = event.coverCrop && event.coverPhotoId === source?.photoId ? event.coverCrop : null;
    if (saved) {
      setCrop(saved);
      setAspect(matchAspect(saved, imgRatio));
    } else {
      setAspect('16:9');
      setCrop(fitAspect({ x: 0, y: 0, width: 1, height: 1 }, 16 / 9, imgRatio));
    }
  }, [open, imgRatio, event.coverCrop, event.coverPhotoId, source?.photoId]);

  const save = useMutation({
    mutationFn: (c: CoverCrop | null) => put(`/events/${event.id}/cover-crop`, { photoId: source!.photoId, crop: c }),
    onSuccess: (_d, c) => {
      toast.success(c ? 'Cover cropped' : 'Cover reset to the full photo');
      onSaved();
      onClose();
    },
  });

  if (!source) return null;
  const aspectValue = ASPECTS.find((a) => a.id === aspect)!.value;

  const pointAt = (e: PointerEvent) => {
    const r = frame.current!.getBoundingClientRect();
    return { px: clamp((e.clientX - r.left) / r.width, 0, 1), py: clamp((e.clientY - r.top) / r.height, 0, 1) };
  };

  const startMove = (e: PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const { px, py } = pointAt(e);
    drag.current = { mode: 'move', startX: px, startY: py, start: crop };
  };

  const startResize = (e: PointerEvent, corner: 'nw' | 'ne' | 'sw' | 'se') => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // The opposite corner stays put while this one follows the pointer.
    drag.current = {
      mode: 'resize',
      ax: corner.includes('w') ? crop.x + crop.width : crop.x,
      ay: corner.includes('n') ? crop.y + crop.height : crop.y,
    };
  };

  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || !imgRatio) return;
    const { px, py } = pointAt(e);
    if (d.mode === 'move') {
      setCrop({ ...d.start, x: clamp(d.start.x + px - d.startX, 0, 1 - d.start.width), y: clamp(d.start.y + py - d.startY, 0, 1 - d.start.height) });
      return;
    }
    const right = px >= d.ax;
    const down = py >= d.ay;
    const wMax = right ? 1 - d.ax : d.ax;
    const hMax = down ? 1 - d.ay : d.ay;
    let w = Math.max(MIN, Math.abs(px - d.ax));
    let h = Math.max(MIN, Math.abs(py - d.ay));
    if (aspectValue) {
      w = Math.min(Math.max(w, (h * aspectValue) / imgRatio), wMax, (hMax * aspectValue) / imgRatio);
      h = (w * imgRatio) / aspectValue;
    } else {
      w = Math.min(w, wMax);
      h = Math.min(h, hMax);
    }
    setCrop({ x: right ? d.ax : d.ax - w, y: down ? d.ay : d.ay - h, width: w, height: h });
  };

  const endDrag = () => { drag.current = null; };

  // Keyboard: arrows move the box; + and − resize it around its centre.
  const onKey = (e: KeyboardEvent) => {
    if (!imgRatio) return;
    const step = e.shiftKey ? 0.05 : 0.01;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      const [dx, dy] = moves[e.key]!;
      setCrop((c) => ({ ...c, x: clamp(c.x + dx, 0, 1 - c.width), y: clamp(c.y + dy, 0, 1 - c.height) }));
    } else if (e.key === '+' || e.key === '=' || e.key === '-') {
      e.preventDefault();
      const f = e.key === '-' ? 0.95 : 1.05;
      setCrop((c) => {
        const width = clamp(c.width * f, MIN, 1);
        const height = aspectValue ? (width * imgRatio) / aspectValue : clamp(c.height * f, MIN, 1);
        return fitAspect({ x: c.x + (c.width - width) / 2, y: c.y + (c.height - height) / 2, width, height }, aspectValue ?? (width / height) * imgRatio, imgRatio);
      });
    }
  };

  const chooseAspect = (id: AspectId) => {
    setAspect(id);
    const value = ASPECTS.find((a) => a.id === id)!.value;
    if (imgRatio) setCrop((c) => fitAspect(c, value, imgRatio));
  };

  const pct = (v: number) => `${v * 100}%`;
  const corners = [
    ['nw', 'left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize'],
    ['ne', 'right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize'],
    ['sw', 'left-0 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize'],
    ['se', 'right-0 bottom-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize'],
  ] as const;

  return (
    <Modal open={open} onClose={onClose} title="Crop cover image" wide>
      <div className="space-y-4">
        <p className="text-sm text-muted">Drag the frame to reposition it and drag a corner to resize it. The cropped cover is what the public gallery, the event list and connected websites show. The original photo is not changed.</p>

        <div role="radiogroup" aria-label="Aspect ratio" className="flex flex-wrap gap-1.5">
          {ASPECTS.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={aspect === a.id}
              onClick={() => chooseAspect(a.id)}
              className={clsx('rounded-md border px-3 py-1 text-xs font-medium transition-colors', aspect === a.id ? 'border-accent bg-accent/15 text-accent' : 'border-border text-muted hover:bg-surface-2')}
            >
              {a.label}
            </button>
          ))}
        </div>

        <div className="flex justify-center rounded-lg bg-surface-2 p-2">
          <div ref={frame} className="relative inline-block touch-none select-none overflow-hidden" onPointerMove={onMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={source.url}
              alt="Cover photo to crop"
              draggable={false}
              className="block max-h-[60vh] max-w-full"
              onLoad={(e) => { const i = e.currentTarget; if (i.naturalWidth && i.naturalHeight) setImgRatio(i.naturalWidth / i.naturalHeight); }}
            />
            {imgRatio && (
              <div
                role="slider"
                tabIndex={0}
                aria-label="Crop area. Arrow keys move it; plus and minus resize it."
                aria-valuetext={`${Math.round(crop.width * 100)}% wide, ${Math.round(crop.height * 100)}% tall, from ${Math.round(crop.x * 100)}% left and ${Math.round(crop.y * 100)}% top`}
                onKeyDown={onKey}
                onPointerDown={startMove}
                className="absolute cursor-move outline-none ring-2 ring-white shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] focus-visible:ring-accent"
                style={{ left: pct(crop.x), top: pct(crop.y), width: pct(crop.width), height: pct(crop.height) }}
              >
                <span aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,transparent_33.2%,rgba(255,255,255,.45)_33.3%,transparent_33.5%,transparent_66.5%,rgba(255,255,255,.45)_66.6%,transparent_66.8%),linear-gradient(to_bottom,transparent_33.2%,rgba(255,255,255,.45)_33.3%,transparent_33.5%,transparent_66.5%,rgba(255,255,255,.45)_66.6%,transparent_66.8%)]" />
                {corners.map(([c, cls]) => (
                  <span key={c} aria-hidden onPointerDown={(e) => startResize(e, c)} className={clsx('absolute size-4 rounded-full border-2 border-white bg-accent shadow', cls)} />
                ))}
              </div>
            )}
          </div>
        </div>

        <ErrorNote error={save.error} />
        <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:items-center">
          {event.coverCrop && event.coverPhotoId === source.photoId && (
            <Button variant="ghost" disabled={save.isPending} loading={save.isPending && save.variables === null} onClick={() => save.mutate(null)}>Use the full photo</Button>
          )}
          <span className="hidden flex-1 sm:block" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!imgRatio} loading={save.isPending && save.variables !== null} onClick={() => save.mutate(crop)}>Save crop</Button>
        </div>
      </div>
    </Modal>
  );
}
