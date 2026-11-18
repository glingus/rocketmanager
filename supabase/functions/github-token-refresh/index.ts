// Entry sottile: rinnova il token utente della GitHub App senza esporre il client secret.
import { handle, json, readJson, str } from "../_shared/http.ts";
import { requireUser } from "../_shared/auth.ts";
import { required } from "../_shared/env.ts";
import { refreshUserToken } from "../_shared/github-app.ts";
import { read, serviceDb } from "../_shared/runtime.ts";

Deno.serve((req: Request) =>
  handle(req, async () => {
    const { db } = serviceDb();
    await requireUser(req, db);
    const body = await readJson(req);
    const tokens = await refreshUserToken({
      clientId: required(read, "GITHUB_APP_CLIENT_ID"),
      clientSecret: required(read, "GITHUB_APP_CLIENT_SECRET"),
      refreshToken: str(body, "refreshToken", { required: true, max: 500 })!,
    });
    return json(200, tokens);
  })
);
