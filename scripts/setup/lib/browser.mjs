// Apertura del browser di sistema (nessuna dipendenza).

import { spawn } from 'node:child_process';

export function openCommand(url, platform = process.platform) {
  if (platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  return { cmd: 'xdg-open', args: [url] };
}

/** Prova ad aprire l'indirizzo. Ritorna true se ha avviato il comando. */
export async function openBrowser(url) {
  const { cmd, args } = openCommand(url);
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.on('error', () => resolve(false));
      child.unref();
      setTimeout(() => resolve(true), 300);
    } catch {
      resolve(false);
    }
  });
}
