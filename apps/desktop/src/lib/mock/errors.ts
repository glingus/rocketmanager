import type { AppError, ErrorCode } from '../types/ipc';

export function appError(code: ErrorCode, message: string, opts: { retryable?: boolean; detail?: string } = {}): AppError {
  return { code, message, retryable: opts.retryable ?? false, ...(opts.detail ? { detail: opts.detail } : {}) };
}

/** Errors are thrown as plain objects (like `invoke` rejections from Tauri). */
export function isAppError(e: unknown): e is AppError {
  return typeof e === 'object' && e !== null && 'code' in e && 'message' in e && 'retryable' in e;
}

export const errors = {
  network: () => appError('network', 'Non riesco a raggiungere il server. Controlla la connessione: le tue versioni restano al sicuro sul PC.', { retryable: true }),
  conflictOpen: () => appError('conflictOpen', 'C’è un conflitto aperto: risolvilo prima di pubblicare o ripristinare.'),
  notLinked: () => appError('notLinked', 'Questo progetto non è collegato a una cartella su questo PC.'),
  nothingToPublish: () => appError('notFound', 'Non ci sono modifiche da pubblicare.'),
  fileNotStable: (path: string) => appError('fileNotStable', `Il file ${path} è ancora in fase di salvataggio. Riprova tra qualche secondo.`, { retryable: true }),
  fileInvalid: (path: string, reason: string) => appError('fileInvalid', `Il file ${path} non è leggibile (${reason}) e non può entrare in una versione.`),
  staleSave: (path: string) => appError('fileNotStable', `Rispondi prima alla domanda su ${path}: potrebbe essere stato salvato da una copia non aggiornata.`),
  blockedByEditor: (paths: string[]) => appError('blockedByEditor', `OpenRocket ha aperto ${paths.join(', ')}. Chiudi il file in OpenRocket e riprova, oppure aggiorna comunque.`),
  localChanges: () => appError('localChangesPresent', 'Ci sono modifiche non pubblicate su questi file. Pubblicale o scartale prima di continuare.'),
  notFound: (what: string) => appError('notFound', `${what} non trovato.`),
  folderInSyncedDrive: (drive: string) => appError('folderInSyncedDrive', `La cartella è dentro ${drive}: la sincronizzazione del cloud può danneggiare il repository.`),
  authRequired: () => appError('authRequired', 'Devi accedere con GitHub per continuare.'),
};
