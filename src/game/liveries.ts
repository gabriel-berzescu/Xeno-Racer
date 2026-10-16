/**
 * Opponent names and liveries.
 */
import type { CarDefinition, Livery } from '../core/contracts';

export const DRIVER_NAMES = [
  'A. Moreau',
  'K. Tanaka',
  'L. Brandt',
  'S. Okafor',
  'M. Rossi',
  'E. Lindqvist',
  'R. Castellanos',
  'J. Whitfield',
  'N. Petrova',
  'T. Haddad',
  'C. Dubois',
  'I. Novak',
  'V. Santos',
  'H. Kowalski',
];

const PALETTES: [string, string, string, Livery['pattern'], boolean][] = [
  ['#c8102e', '#f4f4f4', '#111111', 'stripes', false],
  ['#0a3d91', '#ffd100', '#ffffff', 'arrow', true],
  ['#f5f5f2', '#00843d', '#111111', 'hoops', false],
  ['#ff6b00', '#1a1a1a', '#ffffff', 'split', false],
  ['#1b1b1e', '#e10600', '#e8e8e8', 'shards', true],
  ['#00a19c', '#f2f2f2', '#14213d', 'stripes', true],
  ['#5b2be0', '#16e0bd', '#ffffff', 'shards', true],
  ['#e8c547', '#1d3557', '#ffffff', 'arrow', false],
  ['#2b2d42', '#ef233c', '#edf2f4', 'split', true],
  ['#7a9e7e', '#f0ead2', '#283618', 'hoops', false],
  ['#d4d4d4', '#0057b8', '#ff0000', 'stripes', true],
  ['#9b2226', '#e9d8a6', '#001219', 'solid', true],
];

/** A distinct livery for opponent `i`; avoids the primary color of the player (or of each of the two players of a split screen). */
export function opponentLivery(i: number, def: CarDefinition, avoid?: Livery | readonly Livery[]): Livery {
  let k = i % PALETTES.length;
  const avoided = avoid === undefined ? [] : Array.isArray(avoid) ? (avoid as readonly Livery[]) : [avoid as Livery];
  for (let tries = 0; tries < PALETTES.length && avoided.some((a) => PALETTES[k][0].toLowerCase() === a.primary.toLowerCase()); tries++) k = (k + 1) % PALETTES.length;
  const [primary, secondary, accent, pattern, metallic] = PALETTES[k];
  return {
    primary,
    secondary,
    accent,
    pattern,
    metallic,
    finish: i % 5 === 3 ? 0.5 : 0,
    number: [3, 5, 8, 11, 14, 16, 23, 27, 31, 44, 55, 63, 77, 88][i % 14] + (def.id.length % 2),
    driver: DRIVER_NAMES[i % DRIVER_NAMES.length],
  };
}
