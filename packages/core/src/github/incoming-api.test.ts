import { expect, test } from "vitest";
import { createGitHubClient } from "./client";
import { currentRequest, searchRequested } from "./incoming-api";
import { openStore } from "../store/store";

const clientWith = (fetch: typeof globalThis.fetch) => createGitHubClient({ fetch, tokens: { kind: "pat", token: async () => "test" } });

test("una solicitud a un equipo u otra persona no vale; sigue el cursor hasta la del viewer", async () => {
  let direct = false;
  const client = clientWith(async (_url, options) => {
    const { variables } = JSON.parse(String(options?.body)) as { variables: { after: string | null } };
    const last = variables.after !== null;
    return Response.json({ data: { repository: { pullRequest: {
      state: "OPEN", reviews: { nodes: [] }, reviewRequests: {
        nodes: last ? [{ id: "personal", requestedReviewer: { isViewer: direct } }] : [{ id: "equipo", requestedReviewer: {} }],
        pageInfo: { hasNextPage: !last, endCursor: last ? null : "page2" },
      },
    } } } });
  });
  expect(await currentRequest(client, "owner/repo", 1)).toBeUndefined();
  direct = true;
  expect((await currentRequest(client, "owner/repo", 1))?.requestId).toBe("personal");
});

test("un 304 conserva los números para poder comprobar el plazo; otro repo usa su propia búsqueda", async () => {
  const store = openStore({ path: ":memory:" });
  const etags: (string | null)[] = [];
  try {
    const client = clientWith(async (_url, options) => {
      const etag = new Headers(options?.headers).get("if-none-match");
      etags.push(etag);
      return etag ? new Response(null, { status: 304 }) : Response.json({ items: [{ number: 17 }], total_count: 1 }, { headers: { etag: "v1" } });
    });
    for (const repo of ["org/one", "org/one", "org/two"]) expect(await searchRequested(client, store, "viewer", repo, 1)).toEqual({ numbers: [17], more: false });
    expect(etags).toEqual([null, "v1", null]);
  } finally {
    store.close();
  }
});
