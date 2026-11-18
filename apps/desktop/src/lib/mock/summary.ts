import type { Importance } from '../types/data';

/** Italian summaries, mirroring the SQL function `format_event_summary`. */
export function formatSummary(
  type: string,
  payload: Record<string, unknown>,
  actorName: string,
  projectName: string,
): string {
  const s = (key: string) => String(payload[key] ?? '');
  const title = s('title') || 'senza titolo';
  const target = s('targetName') || 'un utente';
  const files = Number(payload.fileCount ?? (Array.isArray(payload.files) ? payload.files.length : 0));
  const prio = ({ low: 'bassa', medium: 'media', high: 'alta', critical: 'critica' } as Record<string, string>)[s('priority')];
  // Same wording as the SQL function `private.format_event_summary`.
  switch (type) {
    case 'version.published':
      return `${actorName} ha pubblicato la versione ${s('number') || '?'} di ${projectName}`;
    case 'version.restored':
      return `${actorName} ha ripristinato la versione ${s('restoredFrom') || '?'} di ${projectName} (nuova versione ${s('number') || '?'})`;
    case 'conflict.detected':
      return `Conflitto in ${projectName}: ${actorName} ha modifiche in conflitto su ${files === 1 ? '1 file' : `${files} file`}`;
    case 'conflict.resolved':
      return `${actorName} ha risolto il conflitto in ${projectName}${'number' in payload ? ` (versione ${s('number')})` : ''}`;
    case 'member.added':
      return `${actorName} ha aggiunto ${target} a ${projectName}`;
    case 'member.removed':
      return `${actorName} ha rimosso ${target} da ${projectName}`;
    case 'member.role_changed':
      return `${actorName} ha reso ${target} ${s('role') === 'admin' ? 'amministratore' : 'membro'} in ${projectName}`;
    case 'project.created':
      return `${actorName} ha creato il progetto ${projectName}`;
    case 'project.archived':
      return `${actorName} ha archiviato il progetto ${projectName}`;
    case 'card.created':
      return `${actorName} ha creato la nota «${title}»`;
    case 'card.important':
      return `${actorName} ha segnalato «${title}»${prio ? ` (priorità ${prio})` : ''}`;
    case 'card.assigned':
      return `${actorName} ti ha assegnato «${title}»`;
    case 'card.completed':
      return `${actorName} ha completato «${title}»`;
    case 'card.updated':
      return `${actorName} ha aggiornato «${title}»`;
    case 'card.commented':
      return `${actorName} ha commentato «${title}»`;
    case 'file.editing_started':
      return `${actorName} sta modificando ${s('path') || 'un file'}`;
    case 'sync.error':
      return `Errore di sincronizzazione in ${projectName}: ${s('message') || 'errore sconosciuto'}`;
    default:
      return type;
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
  { type: 'card.created', importance: 'info', audience: 'project', notify: false, discordDefault: false, clientAllowed: true, labelIt: 'Nota creata' },
  { type: 'card.important', importance: 'important', audience: 'project', notify: true, discordDefault: true, clientAllowed: true, labelIt: 'Nota importante' },
  { type: 'card.assigned', importance: 'info', audience: 'private', notify: true, discordDefault: false, clientAllowed: true, labelIt: 'Nota assegnata a te' },
  { type: 'card.completed', importance: 'info', audience: 'project', notify: false, discordDefault: false, clientAllowed: true, labelIt: 'Nota completata' },
  { type: 'card.updated', importance: 'info', audience: 'project', notify: false, discordDefault: false, clientAllowed: true, labelIt: 'Nota aggiornata' },
  { type: 'card.commented', importance: 'info', audience: 'project', notify: false, discordDefault: false, clientAllowed: true, labelIt: 'Nuovo commento' },
  { type: 'file.editing_started', importance: 'info', audience: 'project', notify: false, discordDefault: false, clientAllowed: true, labelIt: 'Modifica di un file iniziata' },
  { type: 'sync.error', importance: 'important', audience: 'private', notify: true, discordDefault: false, clientAllowed: true, labelIt: 'Errore di sincronizzazione' },
];
