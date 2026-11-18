/** Date, time and number formatting. Everything uses it-IT and the Europe/Rome time zone. */

export const LOCALE = 'it-IT';
export const TIME_ZONE = 'Europe/Rome';

const dateFmt = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const dateShortFmt = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const timeFmt = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
});
const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const weekdayFmt = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

function toDate(value: string | number | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** "18 novembre 2026" */
export function formatDate(value: string | number | Date): string {
  return dateFmt.format(toDate(value));
}

/** "18/11/2026" */
export function formatDateShort(value: string | number | Date): string {
  return dateShortFmt.format(toDate(value));
}

/** "15:22" */
export function formatTime(value: string | number | Date): string {
  return timeFmt.format(toDate(value));
}

/** "18 nov 2026, 15:22" */
export function formatDateTime(value: string | number | Date): string {
  return dateTimeFmt.format(toDate(value));
}

/** "mercoledì 18 novembre" */
export function formatWeekday(value: string | number | Date): string {
  return weekdayFmt.format(toDate(value));
}

/** Calendar day (Europe/Rome) as YYYY-MM-DD, used for grouping and comparisons. */
export function dayKey(value: string | number | Date): string {
  return dayKeyFmt.format(toDate(value));
}

const relFmt = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });

/**
 * Human friendly distance from `now`: "adesso", "5 minuti fa", "oggi alle 14:05",
 * "ieri alle 09:10", "3 giorni fa", then an absolute date.
 */
export function formatRelative(value: string | number | Date, now: Date | number = new Date()): string {
  const date = toDate(value);
  const nowDate = toDate(now);
  const diffMs = nowDate.getTime() - date.getTime();
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const minutes = Math.round(abs / 60_000);
  if (abs < 45_000) return 'adesso';
  if (minutes < 60) return relFmt.format(future ? minutes : -minutes, 'minute');
  const hours = Math.round(abs / 3_600_000);
  const sameDay = dayKey(date) === dayKey(nowDate);
  if (sameDay) return hours < 3 ? relFmt.format(future ? hours : -hours, 'hour') : `oggi alle ${formatTime(date)}`;
  const dayDiff = Math.round(
    (Date.parse(dayKey(nowDate)) - Date.parse(dayKey(date))) / 86_400_000,
  );
  if (dayDiff === 1) return `ieri alle ${formatTime(date)}`;
  if (dayDiff === -1) return `domani alle ${formatTime(date)}`;
  if (Math.abs(dayDiff) < 7) return relFmt.format(-dayDiff, 'day');
  return formatDate(date);
}

/** "04:32" or "1:02:05" for a countdown in milliseconds. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const numberFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 });
const numberFmt1 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });

export function formatNumber(value: number, maxFractionDigits = 2): string {
  if (maxFractionDigits === 2) return numberFmt.format(value);
  if (maxFractionDigits === 1) return numberFmt1.format(value);
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: maxFractionDigits }).format(value);
}

/** "1,4 MB", "820 KB", "12 B". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const digits = value >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat(LOCALE, { maximumFractionDigits: digits }).format(value)} ${units[i]}`;
}

/** "SF" from "Simone Ferri". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Plural helper for Italian: pluralize(1, 'file', 'file') etc. */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? `${n} ${one}` : `${n} ${many}`;
}

/** Converts a local date input (YYYY-MM-DD) to the end of that day, for due-date checks. */
export function endOfDay(dateStr: string): Date {
  return new Date(`${dateStr}T23:59:59`);
}
