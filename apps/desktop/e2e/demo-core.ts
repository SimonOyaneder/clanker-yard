import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const testkitDir = join(import.meta.dirname, "../../../packages/testkit");

/**
 * `lanes` siembra el proyecto de la vista de Operación, `summary` el del Resumen (lo importado del clanker-loop y corridas de Yard)
 * y `prs` los PRs de Stacks de PR, con el pack de ejemplo (`DEMO_SCENARIO` de `packages/testkit/scripts/demo-core.ts`).
 */
export type DemoScenario = "default" | "lanes" | "summary" | "prs";

export interface DemoCore {
  stop(): Promise<void>;
}

/**
 * Lanza el core de demo del testkit (runtime fake, plantilla `juguete`, proyecto `demo` con 3 issues y el de la bandeja) sobre
 * `home` y espera a que publique `core.json`: desde ahí la app de escritorio se conecta a él en vez de
 * lanzar el core real, que no sabe de runtimes fake.
 */
export async function startDemoCore(home: string, scenario: DemoScenario = "default"): Promise<DemoCore> {
  let log = "";
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/demo-core.ts"], {
    cwd: testkitDir,
    // La bandeja de prueba (`DEMO_INBOX`) solo va en el escenario por defecto: en los demás sumaría corridas y decisiones.
    env: { ...process.env, CLANKER_HOME: home, CORE_RUNTIME: "fake", DEMO_SCENARIO: scenario, ...(scenario === "default" ? { DEMO_INBOX: "1" } : {}) },
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => (log += chunk));

  const deadline = Date.now() + 30_000;
  while (!existsSync(join(home, "core.json"))) {
    if (child.exitCode !== null) throw new Error(`El core de demo terminó antes de publicar core.json:\n${log}`);
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`El core de demo no publicó core.json en 30 s:\n${log}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return {
    async stop() {
      // SIGTERM hace que cierre limpio; si no sale a tiempo se lo mata.
      if (child.exitCode === null) child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(timer);
    },
  };
}
