// Entry sottile: logica e controllo del ruolo in ../_shared/members.ts.
import { HttpError, githubLogin, handle, json, readJson, str, uuid } from "../_shared/http.ts";
import { requireUser } from "../_shared/auth.ts";
import { manageMembers, type MemberAction } from "../_shared/members.ts";
import { githubApp, serviceDb } from "../_shared/runtime.ts";

Deno.serve((req: Request) =>
  handle(req, async () => {
    const { db } = serviceDb();
    const userId = await requireUser(req, db);
    const body = await readJson(req);
    const projectId = uuid(body, "projectId");
    const action = str(body, "action", { required: true });
    const role = str(body, "role");
    if (role !== undefined && role !== "admin" && role !== "member") {
      throw new HttpError(400, "invalid_field", "Ruolo non valido");
    }
    let request: MemberAction;
    if (action === "add") {
      request = { action, projectId, login: githubLogin(body, "login"), role: role ?? "member" };
    } else if (action === "remove") {
      request = {
        action,
        projectId,
        login: body.login ? githubLogin(body, "login") : undefined,
        userId: body.userId ? uuid(body, "userId") : undefined,
      };
    } else if (action === "set_role") {
      if (!role) throw new HttpError(400, "missing_field", "Campo obbligatorio mancante: role");
      request = {
        action,
        projectId,
        role,
        login: body.login ? githubLogin(body, "login") : undefined,
        userId: body.userId ? uuid(body, "userId") : undefined,
      };
    } else {
      throw new HttpError(400, "invalid_action", "Azione non valida (add, remove, set_role)");
    }
    return json(200, await manageMembers(userId, request, { auth: db, db, github: githubApp() }));
  })
);
