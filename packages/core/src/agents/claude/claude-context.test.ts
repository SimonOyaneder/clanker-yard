import { createRuntimeRegistry } from "../runtime";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Brief, Profile, Role } from "@clanker/api";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDefs, type Defs } from "../../defs/defs";
import { newId } from "../../store/conventions";
import { openStore, type Store } from "../../store/store";
import { createAgents } from "../agents";
import { createClaudeRuntime, type QueryFn } from "./claude-runtime";
import { subscriptionCredentials } from "./credentials";

// Agents sobre el runtime claude-sdk de verdad y un `query` falso con la forma de los mensajes del SDK:
// un rol como los de la plantilla (native, el AGENTS.md del repo y un paquete de contexto) ya no se
// rechaza, y lo que pide llega a las opciones de Claude.

let root: string;
let worktree: string;
let userDir: string;
let store: Store;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "claude-context-"));
  worktree = join(root, "worktree");
  userDir = join(root, "claude");
  await mkdir(worktree);
  store = openStore({ path: ":memory:" });
});
afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

const write = async (path: string, content: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const role: Role = {
  prompt: "Eres el que hace los commits.",
  context: [
    { kind: "native", sources: ["user", "project"], skills: [] },
    { kind: "repo", files: ["AGENTS.md"] },
    { kind: "pack", id: "commits" },
  ],
  modes: {
    plan: {
      instructions: "Planea.",
      report: { type: "object", properties: {} },
      outcomes: ["ok"],
      session: "new",
    },
  },
};
const profile: Profile = { roles: { committer: { model: "sonnet" } } };

const message = (m: Record<string, unknown>) => ({ session_id: "sess-1", ...m }) as SDKMessage;
const script = [
  message({ type: "system", subtype: "init", apiKeySource: "none" }),
  message({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "listo",
    structured_output: { outcome: "ok", summary: "", payload: {} },
    total_cost_usd: 0,
    modelUsage: {},
  }),
];

/** `withDefs` guarda defs extra una vez que Agents registró sus kinds. */
async function runPlan(withDefs: (defs: Defs) => void = () => {}) {
  const calls: Options[] = [];
  const query: QueryFn = ({ options }) => {
    calls.push(options);
    return (async function* () {
      yield* script;
    })();
  };
  const defs = createDefs(store);
  const runtime = createClaudeRuntime({
    credentials: async () => subscriptionCredentials({ executable: "/bin/claude" }),
    home: join(root, "home"),
    query,
    baseEnv: { PATH: "/usr/bin", HOME: root, USER: "x" },
  });
  const agents = createAgents({ store, defs, runtimes: createRuntimeRegistry([runtime], {}), userDir });
  defs.save({ kind: "role", slug: "committer", scope: "user", body: role, source: "ui" });
  defs.save({ kind: "profile", slug: "default", scope: "user", body: profile, source: "ui" });
  withDefs(defs);
  const brief: Brief = {
    run: { id: newId("run") as Brief["run"]["id"], subject: { type: "issue", id: "1" }, round: 1, attempt: 1 },
    worktree,
    base: "origin/main",
    mode: "plan",
    artifacts: {},
    payload: {},
  };
  const result = await agents.run({ role: "committer", profile: "default", mode: "plan", brief, workspace: worktree });
  return { result, calls };
}

const contextWarnings = () => store.events.since(0, { types: ["error"] }).filter((e) => e.payload.scope === "agent.context");

describe("un rol con paquete de contexto", () => {
  test("sin el paquete corre igual, con un aviso por lo que falta", async () => {
    await write(join(worktree, "AGENTS.md"), "reglas del repo");

    const { result, calls } = await runPlan();

    expect(result.status).toBe("success");
    expect(calls[0]?.systemPrompt).toEqual([
      "Eres el que hace los commits.",
      "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",
      "# AGENTS.md\n\nreglas del repo",
    ]);
    expect(contextWarnings().map((e) => e.payload.message)).toEqual([
      'El rol "committer" pide el paquete de contexto "commits" y no existe: corre sin él.',
    ]);
  });

  test("con el paquete, la skill va a las opciones de Claude y las reglas al prompt, sin avisos", async () => {
    await write(join(worktree, "AGENTS.md"), "reglas del repo");
    await write(join(userDir, "skills", "commit", "SKILL.md"), "# commit");
    await write(join(userDir, "rules", "git-safety.md"), "confirmar siempre");

    const { result, calls } = await runPlan((defs) =>
      defs.save({
        kind: "context",
        slug: "commits",
        scope: "user",
        body: { refs: ["skill:commit", "rule:git-safety"] },
        source: "ui",
      }),
    );

    expect(result.status).toBe("success");
    expect(calls[0]).toMatchObject({ settingSources: ["user", "project"], skills: ["commit"] });
    expect(calls[0]?.systemPrompt).toEqual([
      "Eres el que hace los commits.",
      "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",
      "# AGENTS.md\n\nreglas del repo\n\n# rule:git-safety\n\nconfirmar siempre",
    ]);
    expect(contextWarnings()).toEqual([]);
  });
});
