/**
 * Pure formatting helpers for the UI (no DOM). All times are seconds.
 */

const pad2 = (n: number): string => (n < 10 ? '0' + n : '' + n);
const pad3 = (n: number): string => (n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n);

/** "1:32.481" — fixed width, tabular-friendly. null/NaN/negative -> "-:--.---". */
export function formatLapTime(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return '-:--.---';
  const total = Math.round(sec * 1000);
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000);
  return m + ':' + pad2(s) + '.' + pad3(ms);
}

/** Race total: "12:03.456", or "1:02:03.456" past an hour. */
export function formatRaceTime(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return '--:--.---';
  const total = Math.round(sec * 1000);
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const hr = Math.floor(total / 3600000);
  return hr > 0 ? hr + ':' + pad2(m) + ':' + pad2(s) + '.' + pad3(ms) : pad2(m) + ':' + pad2(s) + '.' + pad3(ms);
}

/** Signed delta "+0.482" / "-1.117"; null -> "-.---". Magnitudes >= 100 s are clamped for layout. */
export function formatDelta(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '-.---';
  const a = Math.min(99.999, Math.abs(sec));
  const r = Math.round(a * 1000) / 1000;
  const sign = sec < 0 && r > 0 ? '-' : '+';
  return sign + r.toFixed(3);
}

/** Seconds -> displayed speed value in the chosen unit. */
export function speedValue(ms: number, units: 'kmh' | 'mph'): number {
  const v = units === 'mph' ? ms * 2.2369362921 : ms * 3.6;
  return v > 0 ? Math.round(v) : 0;
}
export const speedUnitLabel = (units: 'kmh' | 'mph'): string => (units === 'mph' ? 'MPH' : 'KM/H');

/** Meters -> "5.21 km" / "3.24 mi". */
export function formatLength(m: number, units: 'kmh' | 'mph'): string {
  return units === 'mph' ? (m / 1609.344).toFixed(2) + ' mi' : (m / 1000).toFixed(2) + ' km';
}

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th". */
export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return n + 'th';
  switch (n % 10) {
    case 1: return n + 'st';
    case 2: return n + 'nd';
    case 3: return n + 'rd';
    default: return n + 'th';
  }
}

export function gearLabel(gear: number): string {
  return gear < 0 ? 'R' : gear === 0 ? 'N' : '' + gear;
}

/** "0.85" -> "85%" style helper for sliders. */
export const pct = (v: number): string => Math.round(v * 100) + '%';

/** Display name for a time of day / weather / etc: "golden" -> "Golden hour". */
export const TIME_OF_DAY_LABEL: Record<string, string> = {
  dawn: 'Dawn', morning: 'Morning', noon: 'Noon', golden: 'Golden hour', dusk: 'Dusk', night: 'Night',
};
export const WEATHER_LABEL: Record<string, string> = { clear: 'Clear', cloudy: 'Cloudy', overcast: 'Overcast', rain: 'Rain', storm: 'Storm' };
export const DIFFICULTY_LABEL: Record<string, string> = { rookie: 'Rookie', amateur: 'Amateur', pro: 'Pro', alien: 'Alien' };
export const START_LABEL: Record<string, string> = { back: 'Back of the grid', middle: 'Mid grid', pole: 'Pole position' };
export const LENGTH_LABEL: Record<string, string> = { short: 'Short', standard: 'Standard', long: 'Long' };
export const GRID_LABEL: Record<string, string> = { standings: 'Standings', reverse: 'Reverse' };
export const CAMERA_LABEL: Record<string, string> = {
  chase: 'Chase', 'chase-far': 'Chase (far)', hood: 'Hood', bumper: 'Bumper', cockpit: 'Cockpit', tv: 'TV', orbit: 'Orbit',
};

/** "Golden hour  ·  Clear". */
export function formatConditions(env: { timeOfDay: string; weather: string }): string {
  return `${TIME_OF_DAY_LABEL[env.timeOfDay] ?? env.timeOfDay}  ·  ${WEATHER_LABEL[env.weather] ?? env.weather}`;
}

/** Points behind the leader: "-7", nothing for the leader. */
export const formatPointsGap = (gap: number): string => (gap > 0 ? '-' + gap : '');

/** "1 lap" / "3 laps". */
export const lapsLabel = (n: number): string => `${n} ${n === 1 ? 'lap' : 'laps'}`;

/** Where the player stands against the rest of the table: "12 behind the lead", "5 ahead", "level on points". */
export function leadText(position: number, behind: number, ahead: number): string {
  if (position === 1) return ahead > 0 ? `${ahead} ahead` : 'level on points';
  return behind > 0 ? `${behind} behind the lead` : 'level on points';
}

/** Headline for the player's final place in a championship. */
export function seasonTitle(position: number): string {
  return position === 1 ? 'Champion' : position === 2 ? 'Runner-up' : position === 3 ? 'Third place' : `${ordinal(position)} place`;
}

/** Three-letter code for a track in table headers: "Aurelia Ring" -> "AUR". */
export const trackCode = (name: string): string => name.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase();

/** Upper-cases for display while leaving digits and units alone. */
export const caps = (s: string): string => s.toUpperCase();
