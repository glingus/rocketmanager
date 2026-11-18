import type { DisplayValue } from '../types/ipc';
import { formatNumber } from './format';

/**
 * OpenRocket stores values in SI units (meters, kilograms, radians, seconds).
 * The UI shows them in the units a rocketry team actually uses.
 */
export type Quantity =
  | 'length' // m -> mm
  | 'mass' // kg -> g
  | 'angle' // rad -> deg
  | 'altitude' // m -> m
  | 'velocity' // m/s -> m/s
  | 'time' // s -> s
  | 'force' // N -> N
  | 'accel' // m/s^2
  | 'temp' // degrees Celsius
  | 'count'
  | 'ratio'
  | 'text';

const RAD_TO_DEG = 180 / Math.PI;

/** Convert a raw (SI) value into a DisplayValue. Non numeric raw values are shown as they are. */
export function toDisplay(raw: string, quantity: Quantity): DisplayValue {
  const n = Number(raw);
  if (quantity === 'text' || !Number.isFinite(n)) return { raw, display: raw, unit: null };
  switch (quantity) {
    case 'length':
      return { raw, display: `${formatNumber(n * 1000, 1)} mm`, unit: 'mm' };
    case 'mass':
      return { raw, display: `${formatNumber(n * 1000, 1)} g`, unit: 'g' };
    case 'angle':
      return { raw, display: `${formatNumber(n * RAD_TO_DEG, 1)}°`, unit: '°' };
    case 'altitude':
      return { raw, display: `${formatNumber(n, 0)} m`, unit: 'm' };
    case 'velocity':
      return { raw, display: `${formatNumber(n, 1)} m/s`, unit: 'm/s' };
    case 'time':
      return { raw, display: `${formatNumber(n, 1)} s`, unit: 's' };
    case 'accel':
      return { raw, display: `${formatNumber(n, 0)} m/s²`, unit: 'm/s²' };
    case 'temp':
      return { raw, display: `${formatNumber(n, 0)} °C`, unit: '°C' };
    case 'force':
      return { raw, display: `${formatNumber(n, 0)} N`, unit: 'N' };
    case 'ratio':
      return { raw, display: formatNumber(n, 2), unit: null };
    case 'count':
      return { raw, display: formatNumber(n, 0), unit: null };
  }
}

/** "95 mm" -> { value: 95, unit: 'mm' }. Returns null when there is no leading number. */
export function parseDisplay(display: string): { value: number; unit: string } | null {
  const match = /^\s*(-?\d+(?:[.,]\d+)?)\s*(\S*)\s*$/.exec(display);
  if (!match) return null;
  return { value: Number(match[1]!.replace(',', '.')), unit: match[2] ?? '' };
}

/** "Numero di pinne: 3 → 4" style fragment used by changelog text. */
export function describeChange(label: string, before: DisplayValue | null, after: DisplayValue | null): string {
  if (before && after) return `${label.toLowerCase()} ${before.display} → ${after.display}`;
  if (after) return `${label.toLowerCase()} ${after.display}`;
  if (before) return `${label.toLowerCase()} (era ${before.display})`;
  return label.toLowerCase();
}
