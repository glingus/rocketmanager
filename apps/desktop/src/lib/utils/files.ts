/** `Razzo.ork` -> `Razzo - versione Simone 2026-11-18.ork` (protocol 7.5, choice "both"). */
export function copyFileName(path: string, owner: string, isoDate: string): string {
  const dot = path.lastIndexOf('.');
  const base = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : '';
  return `${base} - versione ${owner} ${isoDate.slice(0, 10)}${ext}`;
}

export function fileExtension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot > 0 ? path.slice(dot + 1).toLowerCase() : '';
}
