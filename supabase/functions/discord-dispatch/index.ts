// Entry sottile, chiamata ogni minuto da pg_cron con la chiave service_role come Bearer.
// Logica in ../_shared/discord.ts (dispatchOutbox).
import { handle, json } from "../_shared/http.ts";
import { requireServiceRole } from "../_shared/auth.ts";
import { dispatchOutbox } from "../_shared/discord.ts";
import { serviceDb } from "../_shared/runtime.ts";

Deno.serve((req: Request) =>
  handle(req, async () => {
    const { db, serviceRoleKey } = serviceDb();
    requireServiceRole(req, serviceRoleKey);
    return json(200, await dispatchOutbox({ db }));
  })
);
