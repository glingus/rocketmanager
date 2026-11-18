// Lettura dei segreti dall'ambiente. Nessun valore nel codice: i nomi sono elencati in
// supabase/.env.example. `read` è iniettabile (Deno.env.get nelle Edge Functions).

import { HttpError } from "./http.ts";

export type EnvReader = (name: string) => string | undefined;

export function required(read: EnvReader, name: string): string {
  const v = read(name);
  if (!v) {
    // Il messaggio per l'utente non rivela quale segreto manca; il dettaglio va nel log del server.
    console.error(`Variabile d'ambiente mancante: ${name}`);
    throw new HttpError(500, "misconfigured", "Configurazione del server incompleta");
  }
  return v;
}

export function supabaseEnv(read: EnvReader) {
  return {
    url: required(read, "SUPABASE_URL"),
    serviceRoleKey: required(read, "SUPABASE_SERVICE_ROLE_KEY"),
  };
}

export function githubAppEnv(read: EnvReader) {
  return {
    appId: required(read, "GITHUB_APP_ID"),
    // Nei segreti le a-capo del PEM si possono scrivere come \n.
    privateKey: required(read, "GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
    org: required(read, "GITHUB_ORG"),
    installationId: read("GITHUB_APP_INSTALLATION_ID") || undefined,
  };
}
