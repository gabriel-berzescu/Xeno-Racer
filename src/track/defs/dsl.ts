import type { Band, Mark, StraightEl, Surf, TurnEl } from '../types';

export const S = (n: string, len: number, free = false): StraightEl => ({ k: 'S', n, len, free });
export const T = (n: string, a: number | 'auto', r: number, o: Partial<TurnEl> = {}): TurnEl => ({ k: 'T', n, a, r, ...o });
export const m = (name: string, off = 0): Mark => [name, off];
export const band = (surf: Surf, w: number): Band => ({ surf, w });
