'use client';

import { useCallback, useEffect, useRef, type MouseEvent, type PointerEvent } from 'react';

/**
 * Selection gestures for a grid of tiles, shared by the event photo grid and the media library:
 *
 *  - click a tile's check mark to select it; Shift-click selects everything between it and the last one;
 *  - Ctrl/Cmd-click a tile selects it without opening it;
 *  - once something is selected, a plain click anywhere on a tile selects or deselects it (no hunting for the check mark);
 *  - press and drag across tiles to select (or deselect) a whole run at once, scrolling when the pointer nears the
 *    top or bottom of the window. With a mouse the drag can start anywhere on a tile; on touch screens it starts on the
 *    check mark so the page still scrolls normally;
 *  - Esc clears the selection; Ctrl/Cmd+A selects every tile on the page. Neither applies while a dialog (such as a
 *    preview) is open, so closing a preview with Esc keeps the selection.
 *
 * Opening an item while selecting is done with a separate preview button (spread `previewProps(open)`), which never
 * changes the selection.
 *
 * The grid marks each tile with `data-sel-idx` (spread `tileProps(i)`) and each check mark with `checkboxProps(i)`.
 */
export interface GridSelectionOptions {
  /** Ids of the tiles on screen, in grid order. */
  ids: string[];
  isSelected: (id: string) => boolean;
  /** Selects `on` and deselects `off` in one update. */
  apply: (on: string[], off: string[]) => void;
  clear: () => void;
  /** How many items are selected in total (on any page). */
  count: number;
  /** False turns every gesture off (for people who may not select). */
  enabled?: boolean;
}

type Drag = {
  start: number;
  /** Select (true) or deselect (false) the tiles dragged over. */
  target: boolean;
  /** Each tile's state when the drag began, to restore tiles the drag leaves again. */
  base: boolean[];
  /** Becomes true once the pointer reaches a second tile (until then it may just be a click). */
  painting: boolean;
  last: number;
  x: number;
  y: number;
};

const EDGE = 70; // px from the window edge where dragging scrolls
const TYPING = 'input, textarea, select, [contenteditable="true"]';

export function useGridSelection({ ids, isSelected, apply, clear, count, enabled = true }: GridSelectionOptions) {
  const anchor = useRef<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const frame = useRef<number | null>(null);
  // Handlers below read the latest values without being recreated on every render.
  const live = useRef({ ids, isSelected, apply, clear, count, enabled });
  live.current = { ids, isSelected, apply, clear, count, enabled };

  // A new page (or new results) starts a new range.
  const idsKey = ids.join(',');
  useEffect(() => { anchor.current = null; }, [idsKey]);

  /** Sets tiles a..b (inclusive) to `on`. */
  const setRange = (a: number, b: number, on: boolean) => {
    const { ids: list, apply: set } = live.current;
    const range = list.slice(Math.min(a, b), Math.max(a, b) + 1);
    set(on ? range : [], on ? [] : range);
  };

  const toggleAt = useCallback((i: number, shift: boolean) => {
    const { ids: list, isSelected: sel, apply: set } = live.current;
    const id = list[i];
    if (!id) return;
    const on = !sel(id);
    if (shift && anchor.current !== null) setRange(anchor.current, i, on);
    else set(on ? [id] : [], on ? [] : [id]);
    anchor.current = i;
  }, []);

  // ---- drag to select ----
  const tileAt = (x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-sel-idx]');
    const n = el ? Number(el.dataset.selIdx) : NaN;
    return Number.isInteger(n) ? n : null;
  };

  const paintTo = (i: number) => {
    const d = drag.current;
    if (!d || i === d.last) return;
    d.last = i;
    const { ids: list, apply: set } = live.current;
    const [a, b] = [Math.min(d.start, i), Math.max(d.start, i)];
    const on: string[] = [];
    const off: string[] = [];
    list.forEach((id, n) => {
      const want = n >= a && n <= b ? d.target : d.base[n]!;
      (want ? on : off).push(id);
    });
    set(on, off);
  };

  const onMove = useCallback((e: globalThis.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.x = e.clientX;
    d.y = e.clientY;
    const i = tileAt(e.clientX, e.clientY);
    if (i === null) return;
    if (!d.painting && i !== d.start) d.painting = true;
    if (d.painting) paintTo(i);
  }, []);

  const stop = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
    document.body.style.userSelect = '';
    if (d?.painting) {
      anchor.current = d.last;
      // The click that ends a drag must not open the tile or toggle it back.
      suppressClick.current = true;
      setTimeout(() => { suppressClick.current = false; }, 0);
    }
  }, [onMove]);

  // While dragging near the top or bottom of the window, keep scrolling and keep selecting.
  const autoScroll = useCallback(() => {
    const d = drag.current;
    if (!d) return;
    if (d.painting) {
      const dy = d.y < EDGE ? -Math.ceil((EDGE - d.y) / 4) : d.y > window.innerHeight - EDGE ? Math.ceil((d.y - (window.innerHeight - EDGE)) / 4) : 0;
      if (dy) {
        window.scrollBy(0, dy);
        const i = tileAt(d.x, d.y);
        if (i !== null) paintTo(i);
      }
    }
    frame.current = requestAnimationFrame(autoScroll);
  }, []);

  const begin = (e: PointerEvent, i: number, fromCheckbox: boolean) => {
    if (!live.current.enabled || e.button !== 0) return;
    // On touch screens a drag on the photo itself scrolls the page; only the check mark starts a selection drag.
    if (e.pointerType !== 'mouse' && !fromCheckbox) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey) return; // those are clicks with a meaning of their own
    const { ids: list, isSelected: sel } = live.current;
    const id = list[i];
    if (!id) return;
    // Release any implicit touch capture so the pointer can move over other tiles.
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    drag.current = { start: i, target: !sel(id), base: list.map(sel), painting: false, last: i, x: e.clientX, y: e.clientY };
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    frame.current = requestAnimationFrame(autoScroll);
  };

  useEffect(() => stop, [stop]);

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { enabled: on, count: n, ids: list, apply: set, clear: reset } = live.current;
      if (!on || (e.target as Element | null)?.closest?.(TYPING) || document.querySelector('dialog[open], [role="dialog"]')) return;
      if (e.key === 'Escape' && n > 0) {
        reset();
        anchor.current = null;
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && list.length) {
        e.preventDefault();
        set(list, []);
      }
    };
    // Capture phase: runs before the browser closes an open dialog on Esc, so the check above still sees it open.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  /** Props for a tile (the element that holds the photo and its check mark). */
  const tileProps = (i: number) => ({
    'data-sel-idx': i,
    onPointerDown: (e: PointerEvent) => begin(e, i, false),
    onDragStart: (e: { preventDefault: () => void }) => e.preventDefault(),
  });

  /**
   * Wraps a tile's "open" click: decides whether the click selects instead. Returns true when it handled the click
   * (the caller then does not open the item).
   */
  const handleTileClick = (e: MouseEvent, i: number): boolean => {
    if (suppressClick.current) { e.preventDefault(); return true; }
    if (!live.current.enabled) return false;
    if (e.shiftKey || e.ctrlKey || e.metaKey || live.current.count > 0) {
      e.preventDefault();
      toggleAt(i, e.shiftKey);
      return true;
    }
    return false;
  };

  /** Props for a tile's check mark button. */
  const checkboxProps = (i: number) => ({
    onPointerDown: (e: PointerEvent) => { e.stopPropagation(); begin(e, i, true); },
    onClick: (e: MouseEvent) => {
      e.stopPropagation();
      if (suppressClick.current) return;
      toggleAt(i, e.shiftKey);
    },
    style: { touchAction: 'none' as const },
  });

  /** Props for a tile's preview button: opens the item and leaves the selection exactly as it is. */
  const previewProps = (open: () => void) => ({
    onPointerDown: (e: PointerEvent) => e.stopPropagation(), // not the start of a selection drag
    onClick: (e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); open(); },
  });

  return { tileProps, checkboxProps, previewProps, handleTileClick, apply: (on: string[], off: string[]) => live.current.apply(on, off), selecting: count > 0 };
}
