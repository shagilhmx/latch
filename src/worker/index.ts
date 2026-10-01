import { Coordinator } from "./coordinator";

export { Coordinator };

const WORKSPACE_ROUTE = /^\/api\/workspaces\/([A-Za-z0-9_-]+)(\/.*)?$/;

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const workspace = WORKSPACE_ROUTE.exec(url.pathname);

  if (workspace !== null) {
    const id = env.COORDINATOR.idFromName(workspace[1] ?? "default");
    return env.COORDINATOR.get(id).fetch(request);
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
