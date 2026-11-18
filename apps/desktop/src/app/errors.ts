import { toAppError } from '../lib/backend/types';
import type { AppError } from '../lib/types/ipc';
import { it } from '../i18n/it';

/** Italian, user-facing text for any thrown value (prefers the core's own `AppError.message`). */
export function errorMessage(e: unknown): string {
  const err = toAppError(e);
  if (err.message && err.code !== 'internal') return err.message;
  if (err.message && err.message !== 'Si è verificato un errore imprevisto.') return err.message;
  return it.errors.byCode[err.code] ?? it.common.unexpectedError;
}

export function errorDetail(e: unknown): string | undefined {
  return toAppError(e).detail;
}

export function asAppError(e: unknown): AppError {
  return toAppError(e);
}
