// Entry sottile: logica in ../_shared/webhook.ts. Va pubblicata SENZA verifica JWT
// (GitHub non ha un token Supabase): l'autenticità è garantita dalla firma HMAC.
import { errorResponse } from "../_shared/http.ts";
import { required } from "../_shared/env.ts";
import { handleGithubWebhook } from "../_shared/webhook.ts";
import { read, serviceDb } from "../_shared/runtime.ts";

Deno.serve(async (req: Request) => {
  try {
    const secret = required(read, "GITHUB_WEBHOOK_SECRET");
    const { db } = serviceDb();
    return await handleGithubWebhook(req, { secret, db });
  } catch (e) {
    return errorResponse(e);
  }
});
