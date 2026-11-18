import type { Importance } from '../types/data';

/** Italian summaries, mirroring the SQL function `format_event_summary`. */
export function formatSummary(
  type: string,
  payload: Record<string, unknown>,
  actorName: string,
  projectName: string,
): string {
  const s = (key: string) => String(payload[key] ?? '');
  switch (type) {
    case 'version.published':
      return `${actorName} ha pubblicato la versione ${s('number')} di ${projectName}`;
    case 'version.restored':
      return `${actorName} ha ripristinato la versione ${s('restoredFrom')} di ${projectName} (nuova versione ${s('number')})`;
    case 'conflict.detected':
      return `Conflitto rilevato su ${s('files')} in ${projectName}`;
    case 'conflict.resolved':
      return `${actorName} ha risolto il conflitto in ${projectName} (versione ${s('number')})`;
    case 'member.added':
      return `${actorName} ha aggiunto ${s('login')} a ${projectName}`;
    case 'member.removed':
      return `${actorName} ha rimosso ${s('login')} da ${projectName}`;
    case 'member.role_changed':
      return `${actorName} ha cambiato il ruolo di ${s('login')} in ${s('role') === 'admin' ? 'Administrator' : 'Member'}`;
    case 'project.created':
      return `${actorName} ha creato il progetto ${projectName}`;
    case 'project.archived':
      return `${actorName} ha archiviato il progetto ${projectName}`;
    case 'card.created':
      return `${actorName} ha creato la card “${s('title')}”`;
    case 'card.important':
      return `${actorName} ha segnalato “${s('title')}” come importante`;
    case 'card.assigned':
      return `${actorName} ti ha assegnato “${s('title')}”`;
    case 'card.completed':
      return `${actorName} ha completato “${s('title')}”`;
    case 'card.updated':
      return `${actorName} ha modificato “${s('title')}”`;
    case 'card.commented':
      return `${actorName} ha commentato “${s('title')}”`;
    case 'file.editing_started':
      return `${actorName} ha iniziato a modificare ${s('path')}`;
    case 'sync.error':
      return `Errore di sincronizzazione su ${projectName}: ${s('message')}`;
    default:
      return `${actorName}: ${type}`;
  }
}

export type CatalogEntry = {
  type: string;
  importance: Importance;
  audience: 'project' | 'private';
  notify: boolean;
  discordDefault: boolean;
  clientAllowed: boolean;
  labelIt: string;
};

/** Mirrors the `event_types` catalogue from docs/modello-dati.md. */
export const EVENT_CATALOG: CatalogEntry[] = [
  { type: 'version.published', importance: 'important', audience: 'project', notify: true, discordDefault: true, clientAllowed: false, labelIt: 'Versione pubblicata' },
  { type: 'version.restored', importance: 'important', audience: 'project', notify: true, discordDefault: true, clientAllowed: false, labelIt: 'Versione ripristinata' },
  { type: 'conflict.detected', importance: 'critical', audience: 'project', notify: true, discordDefault: true, clientAllowed: true, labelIt: 'Conflitto rilevato' },
  { type: 'conflict.resolved', importance: 'important', audience: 'project', notify: true, discordDefault: true, clientAllowed: true, labelIt: 'Conflitto risolto' },
  { type: 'member.added', importance: 'important', audience: 'project', notify: true, discordDefault: true, clientAllowed: false, labelIt: 'Membro aggiunto' },
  { type: 'member.removed', importance: 'important', audience: 'project', notify: true, discordDefault: true, clientAllowed: false, labelIt: 'Membro rimosso' },
  { type: 'member.role_changed', importance: 'important', audience: 'project', notify: true, discordDefault: true, clientAllowed: false, labelIt: 'Ruolo cambiato' },
  { type: 'project.created', importance: 'important', audience: 'project', notify: true, discordDefault: true, clientAllowed: false, labelIt: 'Progetto creato' },
  { type: 'project.archived', importance: 'important', audience: 'project', notify: true, discordDefault: true, clientAllowed: false, labelIt: 'Progetto archiviato' },
  { type: 'card.created', importance: 'info', audience: 'project', notify: false, discordDefault: false, clientAllowed: true, labelIt: 'Card creata' },
  { type: 'card.important', importance: 'important', audience: 'project', notify: true, discordDefault: true, clientAllowed: true, labelIt: 'Card importante (priorità alta o Problema)' },
  { type: 'card.assigned', importance: 'info', audience: 'private', notify: true, discordDefault: false, clientAllowed: true, labelIt: 'Card assegnata a te' },
  { type: 'card.completed', importance: 'info', audience: 'project', notify: false, discordDefault: false, clientAllowed: true, labelIt: 'Card completata' },
  { type: 'card.updated', importance: 'info', audience: 'project', notify: false, discordDefault: false, clientAllowed: true, labelIt: 'Card modificata' },
  { type: 'card.commented', importance: 'info', audience: 'project', notify: false, discordDefault: false, clientAllowed: true, labelIt: 'Nuovo commento' },
  { type: 'file.editing_started', importance: 'info', audience: 'project', notify: false, discordDefault: false, clientAllowed: true, labelIt: 'Inizio modifica di un file' },
  { type: 'sync.error', importance: 'important', audience: 'private', notify: true, discordDefault: false, clientAllowed: true, labelIt: 'Errore di sincronizzazione' },
];
