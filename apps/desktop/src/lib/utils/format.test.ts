import { describe, expect, it } from 'vitest';
import { dayKey, formatBytes, formatCountdown, formatDate, formatDateTime, formatRelative, formatTime, initials, plural } from './format';
import { describeChange, parseDisplay, toDisplay } from './units';

describe('date formatting (it-IT, Europe/Rome)', () => {
  it('formats in Rome time, not UTC', () => {
    // 2026-11-18T14:22:00Z is 15:22 in Rome (CET, UTC+1)
    expect(formatTime('2026-11-18T14:22:00Z')).toBe('15:22');
    // summer time: UTC+2
    expect(formatTime('2026-07-01T14:22:00Z')).toBe('16:22');
  });

  it('writes Italian month names', () => {
    expect(formatDate('2026-11-18T12:00:00Z')).toBe('18 novembre 2026');
    expect(formatDateTime('2026-11-18T14:22:00Z')).toMatch(/18 nov 2026/);
  });

  it('groups by Rome calendar day', () => {
    expect(dayKey('2026-11-18T23:30:00Z')).toBe('2026-11-19');
  });

  it('describes distances relative to now', () => {
    const now = new Date('2026-11-18T12:00:00Z');
    expect(formatRelative('2026-11-18T11:59:50Z', now)).toBe('adesso');
    expect(formatRelative('2026-11-18T11:30:00Z', now)).toBe('30 minuti fa');
    expect(formatRelative('2026-11-18T08:00:00Z', now)).toBe('oggi alle 09:00');
    expect(formatRelative('2026-11-17T09:10:00Z', now)).toBe('ieri alle 10:10');
    expect(formatRelative('2026-11-14T09:10:00Z', now)).toMatch(/4 giorni fa/);
    expect(formatRelative('2026-10-01T09:10:00Z', now)).toBe('1 ottobre 2026');
  });
});

describe('number helpers', () => {
  it('formats a countdown', () => {
    expect(formatCountdown(7 * 60_000)).toBe('7:00');
    expect(formatCountdown(65_500)).toBe('1:06');
    expect(formatCountdown(-5)).toBe('0:00');
    expect(formatCountdown(3_725_000)).toBe('1:02:05');
  });

  it('formats byte sizes with Italian decimals', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(12)).toBe('12 B');
    expect(formatBytes(1536)).toBe('1,5 KB');
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB');
  });

  it('builds initials and plurals', () => {
    expect(initials('Simone Ferri')).toBe('SF');
    expect(initials('Madonna')).toBe('MA');
    expect(plural(1, 'file', 'file')).toBe('1 file');
    expect(plural(3, 'versione', 'versioni')).toBe('3 versioni');
  });
});

describe('OpenRocket units', () => {
  it('shows SI values in the units the team uses', () => {
    expect(toDisplay('0.095', 'length')).toEqual({ raw: '0.095', display: '95 mm', unit: 'mm' });
    expect(toDisplay('0.0855', 'mass').display).toBe('85,5 g');
    expect(toDisplay('0.1745329', 'angle').display).toBe('10°');
    expect(toDisplay('845', 'altitude').display).toBe('845 m');
    expect(toDisplay('214.3', 'velocity').display).toBe('214,3 m/s');
    expect(toDisplay('4', 'count').display).toBe('4');
    expect(toDisplay('Von Kármán', 'text')).toEqual({ raw: 'Von Kármán', display: 'Von Kármán', unit: null });
    expect(toDisplay('abc', 'length').display).toBe('abc');
  });

  it('parses display values back', () => {
    expect(parseDisplay('95 mm')).toEqual({ value: 95, unit: 'mm' });
    expect(parseDisplay('85,5 g')).toEqual({ value: 85.5, unit: 'g' });
    expect(parseDisplay('nessun numero')).toBeNull();
  });

  it('describes a change as before to after', () => {
    expect(describeChange('Numero di pinne', toDisplay('3', 'count'), toDisplay('4', 'count'))).toBe('numero di pinne 3 → 4');
  });
});
