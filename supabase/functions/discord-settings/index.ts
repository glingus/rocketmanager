// Entry sottile: logica in ../_shared/discord.ts (discordSettings). Non restituisce mai l'URL.
import { HttpError, handle, json, readJson, str, uuid } from "../_shared/http.ts";
import { requireUser } from "../_shared/auth.ts";
import { discordSettings, type DiscordSettingsRequest } from "../_shared/discord.ts";
import { serviceDb } from "../_shared/runtime.ts";

Deno.serve((req: Request) =>
  handle(req, async () => {
    const { db } = serviceDb();
    const userId = await requireUser(req, db);
    const body = await readJson(req);
    const projectId = uuid(body, "projectId");
    const action = str(body, "action", { required: true });
    let request: DiscordSettingsRequest;
    if (action === "set") {
      request = {
        action,
        projectId,
        webhookUrl: str(body, "webhookUrl", { required: true, max: 300 })!,
        sendTest: body.sendTest === true,
      };
    } else if (action === "remove" || action === "test") {
      request = { action, projectId };
    } else {
      throw new HttpError(400, "invalid_action", "Azione non valida (set, remove, test)");
    }
    return json(200, await discordSettings(userId, request, { auth: db, db }));
  })
);
