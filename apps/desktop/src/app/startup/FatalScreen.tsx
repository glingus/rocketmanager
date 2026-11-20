import { useState, type CSSProperties } from 'react';

/**
 * Last-resort error screen. It must work when everything else failed: no CSS modules, no lazy
 * chunks, no data layer, no router. Styles are inline (with the theme variables and a literal
 * fallback each, since tokens.css is the only stylesheet in the entry chunk).
 */

export type FatalKind = 'config' | 'startup' | 'render';

export type FatalInfo = { kind: FatalKind; title: string; message: string; steps: string[]; detail: string };

const isConfigError = (e: unknown) => typeof e === 'object' && e !== null && (e as { name?: string }).name === 'ConfigMissingError';

export function describeFatal(error: unknown, phase: 'startup' | 'render'): FatalInfo {
  const raw = error instanceof Error ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}` : String(error);
  const sources = isConfigError(error) ? ((error as { sources?: string[] }).sources ?? []) : [];
  const detail = [raw, sources.length ? `\nFonti controllate: ${sources.join('; ')}` : '', `\nVersione: ${typeof navigator === 'undefined' ? '-' : navigator.userAgent}`].join('');
  if (isConfigError(error)) {
    return {
      kind: 'config',
      title: 'Rocket Sync non è configurato',
      message: 'Mancano l\'indirizzo e la chiave pubblica del progetto Supabase, quindi l\'app non può collegarsi al team.',
      steps: [
        'Se hai installato l\'app da una release: scarica e installa l\'ultima versione, oppure chiedi a chi mantiene il progetto di pubblicare una release con le variabili SUPABASE_URL, SUPABASE_ANON_KEY e PROJECTS_ORG impostate (docs/configurazione-iniziale.md, §7).',
        'In alternativa crea il file %APPDATA%\\it.rocketsync.app\\config.json con {"supabaseUrl": "https://<ref>.supabase.co", "supabaseAnonKey": "<chiave anon>", "githubOrg": "<organizzazione>"} e premi Riprova.',
        'Se stai sviluppando: imposta VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY (vedi .env.example) oppure avvia con VITE_BACKEND=mock.',
      ],
      detail,
    };
  }
  if (phase === 'render') {
    return {
      kind: 'render',
      title: 'Qualcosa è andato storto',
      message: 'Si è verificato un errore nella schermata. I tuoi file e le versioni sono al sicuro: riprova, e se si ripete invia la diagnostica a chi mantiene il progetto.',
      steps: [],
      detail,
    };
  }
  return {
    kind: 'startup',
    title: 'Rocket Sync non riesce ad avviarsi',
    message: 'Durante l\'avvio si è verificato un errore. I tuoi file e le versioni non sono stati toccati: riprova, e se si ripete invia la diagnostica a chi mantiene il progetto.',
    steps: [],
    detail,
  };
}

const v = (name: string, fallback: string) => `var(${name}, ${fallback})`;

const S: Record<string, CSSProperties> = {
  page: { minHeight: '100%', height: '100vh', overflow: 'auto', display: 'grid', placeItems: 'center', padding: 24, background: v('--bench', '#e6ddca'), color: v('--ink-900', '#251c16'), fontFamily: v('--font-body', "'Segoe UI', system-ui, sans-serif"), fontSize: 14, lineHeight: 1.5 },
  card: { width: 'min(640px, 100%)', background: v('--paper-0', '#fefbf4'), border: `1px solid ${v('--line-strong', '#b8a57f')}`, borderRadius: 8, boxShadow: '0 6px 24px rgba(44,15,9,0.18)', overflow: 'hidden' },
  head: { background: v('--cherry-800', '#561d12'), color: v('--wood-ink', '#f8ecd9'), padding: '14px 20px', fontFamily: v('--font-display', "'Arial Narrow', 'Segoe UI', sans-serif"), fontSize: 20, fontWeight: 600, letterSpacing: '0.02em' },
  body: { padding: '18px 20px 20px', display: 'grid', gap: 12 },
  p: { margin: 0 },
  ol: { margin: 0, paddingLeft: 20, display: 'grid', gap: 6, color: v('--ink-700', '#483a30') },
  detail: { margin: 0, padding: 10, maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: v('--paper-2', '#f1e9d6'), border: `1px solid ${v('--line', '#d6c8aa')}`, borderRadius: 4, fontFamily: v('--font-mono', 'Consolas, monospace'), fontSize: 12, color: v('--ink-800', '#33271f') },
  row: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  btn: { font: 'inherit', fontWeight: 600, padding: '8px 14px', borderRadius: 4, border: `1px solid ${v('--line-strong', '#b8a57f')}`, background: v('--paper-1', '#faf5ea'), color: v('--ink-900', '#251c16'), cursor: 'pointer' },
  primary: { background: v('--cherry-700', '#6e2717'), borderColor: v('--cherry-800', '#561d12'), color: v('--wood-ink', '#f8ecd9') },
  note: { margin: 0, fontSize: 13, color: v('--ink-600', '#5d4e42') },
};

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function exportDiagnosticsViaTauri(): Promise<string> {
  // Imported directly (not through lib/backend, whose top-level await is part of what may have failed).
  const { tauriBackend } = await import('../../lib/backend/tauri');
  return tauriBackend.exportDiagnostics();
}

export function FatalScreen({
  error,
  phase,
  onRetry = () => window.location.reload(),
  exportDiagnostics = exportDiagnosticsViaTauri,
  canExport = inTauri(),
}: {
  error: unknown;
  phase: 'startup' | 'render';
  onRetry?: () => void;
  exportDiagnostics?: () => Promise<string>;
  canExport?: boolean;
}) {
  const info = describeFatal(error, phase);
  const [note, setNote] = useState('');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(info.detail);
      setNote('Dettaglio copiato.');
    } catch {
      setNote('Non riesco a copiare: seleziona il testo qui sopra e copialo a mano.');
    }
  };
  const exportDiag = async () => {
    setNote('Preparo la diagnostica…');
    try {
      setNote(`Diagnostica salvata in: ${await exportDiagnostics()}`);
    } catch (e) {
      setNote(`Non sono riuscito a esportare la diagnostica: ${e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e)}`);
    }
  };

  return (
    <div style={S.page} role="alert" data-testid="fatal-screen" data-kind={info.kind}>
      <div style={S.card}>
        <div style={S.head}>{info.title}</div>
        <div style={S.body}>
          <p style={S.p}>{info.message}</p>
          {info.steps.length > 0 && (
            <ol style={S.ol}>
              {info.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          )}
          <details>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Dettaglio tecnico</summary>
            <pre style={{ ...S.detail, marginTop: 8 }} tabIndex={0} aria-label="Dettaglio tecnico">{info.detail}</pre>
          </details>
          <div style={S.row}>
            <button type="button" style={{ ...S.btn, ...S.primary }} onClick={onRetry}>
              Riprova
            </button>
            <button type="button" style={S.btn} onClick={() => void copy()}>
              Copia dettaglio
            </button>
            {canExport && (
              <button type="button" style={S.btn} onClick={() => void exportDiag()}>
                Esporta diagnostica
              </button>
            )}
          </div>
          {note && (
            <p style={S.note} role="status">
              {note}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
