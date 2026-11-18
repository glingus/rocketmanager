import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tokens.css'), 'utf8');
const tokens = new Map<string, string>();
for (const m of css.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) tokens.set(m[1]!, m[2]!);

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const h = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join('')}` : hex;
  const n = parseInt(h.slice(1, 7), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
const c = (name: string): string => {
  const v = tokens.get(name);
  if (!v) throw new Error(`token --${name} not found`);
  return v;
};

const AA_TEXT = 4.5;
const AA_UI = 3;

describe('colour tokens meet WCAG AA', () => {
  it('parses the tokens', () => {
    expect(tokens.size).toBeGreaterThan(60);
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });

  const text: Array<[string, string, string]> = [
    // ink on technical paper (data areas)
    ['ink-900', 'paper-0', 'body text'],
    ['ink-900', 'paper-1', 'body text'],
    ['ink-900', 'paper-2', 'sunken panels'],
    ['ink-900', 'paper-3', 'table headers'],
    ['ink-900', 'bench', 'page background'],
    ['ink-800', 'paper-1', 'headings'],
    ['ink-700', 'paper-1', 'secondary text'],
    ['ink-700', 'paper-2', 'secondary text, sunken'],
    ['ink-600', 'paper-1', 'muted text'],
    ['ink-600', 'paper-2', 'muted text, sunken'],
    ['ink-600', 'paper-3', 'muted text on headers'],
    ['ink-600', 'bench', 'muted text on the bench'],
    ['ink-500', 'paper-0', 'placeholders'],
    // light text on wood
    ['wood-ink', 'cherry-600', 'sidebar / header text'],
    ['wood-ink', 'cherry-700', 'sidebar / header text'],
    ['wood-ink', 'cherry-800', 'badges on wood'],
    ['wood-ink-muted', 'cherry-700', 'muted text on wood'],
    ['wood-ink', 'walnut-800', 'tabs, toasts, column headers'],
    ['wood-ink-muted', 'walnut-800', 'muted text on walnut'],
    ['brass-300', 'walnut-800', 'brass on walnut'],
    ['brass-300', 'cherry-800', 'brass on wood'],
    // status lamps: text ink on pale background
    ['lamp-green-ink', 'lamp-green-bg', 'green badge'],
    ['lamp-amber-ink', 'lamp-amber-bg', 'amber badge'],
    ['lamp-red-ink', 'lamp-red-bg', 'red badge'],
    ['lamp-blue-ink', 'lamp-blue-bg', 'blue badge'],
    ['lamp-green-ink', 'paper-1', 'green label'],
    ['lamp-amber-ink', 'paper-1', 'amber label'],
    ['lamp-red-ink', 'paper-1', 'red label'],
    ['lamp-blue-ink', 'paper-1', 'blue label'],
    // note colours: ink on tinted cards
    ...['crema', 'ottone', 'rame', 'ruggine', 'prugna', 'cobalto', 'petrolio', 'oliva', 'acciaio', 'grafite'].map(
      (n) => ['ink-900', `cc-${n}-bg`, `card ${n}`] as [string, string, string],
    ),
    ...['crema', 'ottone', 'rame', 'ruggine', 'prugna', 'cobalto', 'petrolio', 'oliva', 'acciaio', 'grafite'].map(
      (n) => ['ink-700', `cc-${n}-bg`, `card ${n} secondary`] as [string, string, string],
    ),
  ];
  for (const [fg, bg, what] of text) {
    it(`${fg} on ${bg} (${what}) >= 4.5`, () => {
      expect(contrast(c(fg), c(bg))).toBeGreaterThanOrEqual(AA_TEXT);
    });
  }

  const ui: Array<[string, string, string]> = [
    ['focus-ring', 'paper-1', 'focus ring on paper'],
    ['focus-ring', 'paper-3', 'focus ring on table headers'],
    ['focus-ring-on-wood', 'cherry-700', 'focus ring on wood'],
    ['focus-ring-on-wood', 'walnut-800', 'focus ring on walnut'],
    ['steel-500', 'paper-0', 'checkbox / radio border'],
    ['steel-500', 'paper-1', 'lamp bezel on paper'],
    ['steel-500', 'bench', 'lamp bezel on the bench'],
  ];
  for (const [fg, bg, what] of ui) {
    it(`${fg} on ${bg} (${what}) >= 3`, () => {
      expect(contrast(c(fg), c(bg))).toBeGreaterThanOrEqual(AA_UI);
    });
  }

  it('lamp icons are readable on the lit bulb (icon is white, dark on amber)', () => {
    expect(contrast('#ffffff', c('lamp-green'))).toBeGreaterThanOrEqual(AA_UI);
    expect(contrast('#ffffff', c('lamp-red'))).toBeGreaterThanOrEqual(AA_UI);
    expect(contrast('#ffffff', c('lamp-blue'))).toBeGreaterThanOrEqual(AA_UI);
    expect(contrast('#2a1a05', c('lamp-amber'))).toBeGreaterThanOrEqual(AA_UI);
  });

  it('primary (brass) and danger buttons keep readable labels', () => {
    expect(contrast('#2a1a05', c('brass-400'))).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast('#2a1a05', c('brass-500'))).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast('#ffffff', '#a42a1f')).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast('#ffffff', '#c8493b')).toBeGreaterThanOrEqual(AA_TEXT);
  });
});
