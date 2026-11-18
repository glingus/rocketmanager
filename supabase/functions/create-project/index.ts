// Entry sottile: tutta la logica è in ../_shared/create-project.ts.
import { handle, json, readJson, str } from "../_shared/http.ts";
import { requireUser } from "../_shared/auth.ts";
import { createProject } from "../_shared/create-project.ts";
import { githubApp, serviceDb } from "../_shared/runtime.ts";

Deno.serve((req: Request) =>
  handle(req, async () => {
    const { db } = serviceDb();
    const userId = await requireUser(req, db);
    const body = await readJson(req);
    const github = githubApp();
    const result = await createProject(
      {
        userId,
        name: str(body, "name", { required: true, max: 80 })!,
        description: str(body, "description", { max: 500 }),
      },
      { github, db },
    );
    return json(201, result);
  })
);
