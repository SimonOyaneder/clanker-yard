import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { COMMAND_OUTPUT_MAX_CHARS, type StepRunId } from "@clanker/api";
import { afterEach, describe, expect, test } from "vitest";
import { stepLogPath } from "../workspaces/exec";
import { harness as createHarness, okReport } from "./harness";
import { createStepDetails, parseCommandLog, StepNotFoundError } from "./step-detail";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const FLOW = {
  schema: 1,
  id: "con-agente",
  name: "Con agente",
  trigger: { type: "manual" },
  start: "tests",
  nodes: {
    tests: { type: "action", action: "tests", args: { scope: "changed" }, on: { ok: "plan" } },
    plan: { type: "agent", role: "dev", mode: "plan", brief: { nota: "hola" }, on: { ok: "@done", changes: "@blocked" } },
  },
};

describe("StepDetails.get", () => {
  async function finishedRun() {
    const h = createHarness({ script: () => Promise.resolve(okReport({ n: 7 })) });
    cleanups.push(h.cleanup);
    const logDir = mkdtempSync(join(tmpdir(), "step-logs-"));
    cleanups.push(() => rmSync(logDir, { recursive: true, force: true }));
    h.action("tests", ["ok"]);
    h.save(FLOW);
    const runId = h.start("con-agente");
    await h.finished(runId);
    const steps = h.flows.getRun(runId).steps;
    const step = (nodeId: string) => steps.find((s) => s.nodeId === nodeId)!;
    return { h, runId, step, details: createStepDetails({ store: h.store, logDir }), logDir };
  }

  test("un paso de agente trae su sesión con el rol, el reporte validado y su brief y output como artefactos", async () => {
    const { details, step } = await finishedRun();

    const detail = await details.get(step("plan").id);

    expect(detail.sessions).toHaveLength(1);
    expect(detail.sessions[0]).toMatchObject({
      runtime: "fake",
      sessionRef: "ses-1",
      role: "dev",
      model: "sonnet",
      status: "success",
      turns: 2,
      usage: { input: 10, output: 20 },
      report: { outcome: "ok", summary: "listo", payload: { n: 7 } },
    });
    expect(detail.artifacts.map((a) => a.name)).toEqual(["input", "output"]);
    expect(detail.commands).toEqual([]);
  });

  test("un paso de acción no tiene sesiones y trae los comandos de su log con su exit", async () => {
    const { details, step, runId, logDir } = await finishedRun();
    const tests = step("tests");
    const log = stepLogPath(logDir, runId, tests.id);
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, "$ npm test\n1 passed\n[exit 0]\n\n$ npm run lint\nerror: x\n[exit 2]\n\n");

    const detail = await details.get(tests.id);

    expect(detail.sessions).toEqual([]);
    expect(detail.commands).toEqual([
      { command: "npm test", output: "1 passed", truncated: false, exitCode: 0, killedBy: null },
      { command: "npm run lint", output: "error: x", truncated: false, exitCode: 2, killedBy: null },
    ]);
  });

  test("un paso que no existe lanza StepNotFoundError", async () => {
    const { details } = await finishedRun();
    await expect(details.get("stp_01J0000000000000000000000X" as StepRunId)).rejects.toThrow(StepNotFoundError);
  });
});

describe("parseCommandLog", () => {
  test("un comando sin pie sigue corriendo y uno que mató una señal no tiene exit", () => {
    const log = "$ sleep 1\n[terminó por timeout]\n\n$ npm test\nvan 3 de 10\n";
    expect(parseCommandLog(log)).toEqual([
      { command: "sleep 1", output: "", truncated: false, exitCode: null, killedBy: "timeout" },
      { command: "npm test", output: "van 3 de 10", truncated: false, exitCode: null, killedBy: null },
    ]);
  });

  test("una salida enorme se queda con su final", () => {
    const output = `${"a".repeat(COMMAND_OUTPUT_MAX_CHARS)}fin`;
    const [command] = parseCommandLog(`$ x\n${output}\n[exit 1]\n\n`);
    expect(command).toMatchObject({ truncated: true, exitCode: 1 });
    expect(command!.output).toHaveLength(COMMAND_OUTPUT_MAX_CHARS);
    expect(command!.output.endsWith("fin")).toBe(true);
  });

  test("una línea de la salida que empieza con `$ ` no parte el bloque", () => {
    const [command, ...rest] = parseCommandLog("$ make\n$ echo hecho\nhecho\n[exit 0]\n\n");
    expect(rest).toEqual([]);
    expect(command).toMatchObject({ command: "make", output: "$ echo hecho\nhecho", exitCode: 0 });
  });
});
