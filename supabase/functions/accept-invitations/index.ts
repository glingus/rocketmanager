// Entry sottile: logica in ../_shared/members.ts (acceptInvitations).
import { handle, json } from "../_shared/http.ts";
import { requireUser } from "../_shared/auth.ts";
import { acceptInvitations } from "../_shared/members.ts";
import { serviceDb } from "../_shared/runtime.ts";

Deno.serve((req: Request) =>
  handle(req, async () => {
    const { db } = serviceDb();
    const userId = await requireUser(req, db);
    return json(200, await acceptInvitations(userId, { db }));
  })
);
