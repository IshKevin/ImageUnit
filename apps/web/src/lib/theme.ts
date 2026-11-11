'use client';

import { useCallback, useEffect, useState } from 'react';
import { THEME_KEY as KEY } from './theme-script';

export type ThemePref = 'light' | 'dark' | 'system';

function read(): ThemePref {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>('system');
  useEffect(() => setPref(read()), []);
  const set = useCallback((next: ThemePref) => {
    setPref(next);
    const root = document.documentElement;
    if (next === 'system') delete root.dataset.theme;
    else root.dataset.theme = next;
    try {
      if (next === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      /* storage blocked: the choice lasts for this page only */
    }
  }, []);
  return { pref, set };
}
