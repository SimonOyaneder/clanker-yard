import type { Flows } from "@clanker/core";
import { z } from "zod";

// Las acciones y waits que usan las plantillas de flujo (`techlead-clasico`, `pr-feedback`) y todavía no
// tienen implementación, con los outcomes del diseño (`docs/design.html#d-flows`): sirven para validar un
// flujo y recorrerlo con el runtime fake sin depender de Workspaces ni de CodeHost. Las que ya existen
// (`pr.reply`, `review.requestBot`) las registra el test con su acción real.

type StubSpec = {
  outcomes: string[];
  /** El output que lleva cada outcome si el test no da otro; es lo que los demás nodos leen como `$nodo`. */
  outputs: Record<string, unknown>;
} & ({ kind: "action"; effects: "local" | "remote" } | { kind: "wait" });

const prRef = { account: "acme", repo: "acme/web", number: 1 };

const SPECS: Record<string, StubSpec> = {
  "workspace.acquire": {
    kind: "action",
    outcomes: ["ok"],
    effects: "local",
    outputs: { ok: { workspaceId: "wsp_stub", path: "/work/tree", branch: "cla-1", baseSha: "0".repeat(40), fencingToken: 1 } },
  },
  "workspace.syncBase": {
    kind: "action",
    outcomes: ["same", "rebased", "conflict"],
    effects: "local",
    outputs: { conflict: { conflicts: ["app/models/transfer.rb"], failures: "CONFLICT (content)" } },
  },
  "recipe.check": {
    kind: "action",
    outcomes: ["ok", "fail"],
    effects: "local",
    outputs: { ok: { specsChanged: true }, fail: { failures: "1 test rojo" } },
  },
  "pr.publish": { kind: "action", outcomes: ["ok", "replan"], effects: "remote", outputs: { ok: { pr: prRef } } },
  "pr.pushFixups": {
    kind: "action",
    outcomes: ["ok", "route"],
    effects: "remote",
    outputs: { ok: { byItem: { b1: "abc1234" } }, route: { unrouted: [] } },
  },
  "pr.botReview": {
    kind: "wait",
    outcomes: ["lgtm", "findings"],
    outputs: { findings: { items: [{ id: "b1", kind: "bot", path: "app/models/transfer.rb", line: 42, text: "Falta validar el monto" }] } },
  },
  "pr.ci": {
    kind: "wait",
    outcomes: ["ok", "fail"],
    outputs: { fail: { failures: [{ id: "c1", kind: "ci", text: "spec/models/transfer_spec.rb falla" }] } },
  },
};

/** Lo que una llamada del stub da: un outcome, con su output si no es el de `SPECS`. */
export type StubResult = string | { outcome: string; output?: unknown };

export interface FlowStubs {
  /** Los args (con sus refs ya resueltos) de cada llamada, por nombre de acción o wait. */
  calls: Record<string, unknown[]>;
}

export interface FlowStubsOptions {
  /**
   * Los resultados de cada llamada a un stub, en orden. Cuando se acaban, da el primer outcome del stub
   * (`ok`, `lgtm`, `same`...). Un nombre que no es de una acción o wait de las plantillas es un error.
   */
  script?: Record<string, StubResult[]>;
  /** Stubs que el test no registra porque registra la acción real. */
  skip?: string[];
  /** Pisa el output que un stub da por defecto con cada outcome, por nombre de acción o wait. */
  outputs?: Record<string, Record<string, unknown>>;
}

export function registerFlowStubs(flows: Flows, { script = {}, skip = [], outputs = {} }: FlowStubsOptions = {}): FlowStubs {
  for (const name of [...Object.keys(script), ...skip, ...Object.keys(outputs)]) {
    if (!Object.hasOwn(SPECS, name)) throw new Error(`"${name}" no es una acción ni un wait de las plantillas (${Object.keys(SPECS).join(", ")}).`);
  }
  const calls: Record<string, unknown[]> = {};
  const queues = new Map(Object.entries(script).map(([name, results]) => [name, [...results]]));
  const args = z.record(z.string(), z.unknown());

  function next(name: string, spec: StubSpec) {
    const given = queues.get(name)?.shift();
    const outcome = typeof given === "string" ? given : (given?.outcome ?? spec.outcomes[0] ?? "ok");
    if (!spec.outcomes.includes(outcome)) throw new Error(`"${outcome}" no es un outcome de ${name} (${spec.outcomes.join(", ")}).`);
    const output = typeof given === "object" && "output" in given ? given.output : (outputs[name]?.[outcome] ?? spec.outputs[outcome]);
    return { outcome, output };
  }

  for (const [name, spec] of Object.entries(SPECS)) {
    if (skip.includes(name)) continue;
    const record = (value: Record<string, unknown>) => void (calls[name] ??= []).push(value);
    if (spec.kind === "action") {
      flows.registerAction({
        name,
        args,
        outcomes: spec.outcomes,
        effects: spec.effects,
        run: (value) => {
          record(value);
          return Promise.resolve(next(name, spec));
        },
      });
    } else {
      // Resuelve al entrar: el sondeo da el resultado guionado sin esperar ningún evento.
      flows.registerWait({
        name,
        args,
        outcomes: spec.outcomes,
        key: () => `stub:${name}`,
        match: () => undefined,
        probe: (value) => {
          record(value);
          return Promise.resolve(next(name, spec));
        },
      });
    }
  }
  return { calls };
}
