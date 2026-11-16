import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CachedIssue, IssueId, RunId } from "@clanker/api";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runs } from "../store/schema";
import { openStore, type Store } from "../store/store";
import { freshIssueBranch, issueBranch, suggestedBranch } from "./branch-name";

const issue = (
  key: string,
  title: string,
  branchName?: string,
  id = `iss_${key}`,
): CachedIssue =>
  ({
    id: id as IssueId,
    ref: { key },
    title,
    ...(branchName ? { branchName } : {}),
  }) as CachedIssue;

describe("suggestedBranch", () => {
  test("usa el nombre que sugiere el tracker sin el prefijo del usuario", () => {
    expect(
      suggestedBranch(
        issue("ENG-9286", "x", "simon/eng-9286-reject-frozen-account"),
      ),
    ).toBe("eng-9286-reject-frozen-account");
  });

  test("un nombre sugerido sin prefijo queda igual", () => {
    expect(
      suggestedBranch(issue("ENG-9286", "x", "eng-9286-reject-frozen-account")),
    ).toBe("eng-9286-reject-frozen-account");
  });

  test("sin sugerido: key en minúscula y slug ascii del título, sin tildes ni símbolos", () => {
    expect(
      suggestedBranch(
        issue("ENG-12", "Rechazar transferencias: ¡Ñoño & café!"),
      ),
    ).toBe("eng-12-rechazar-transferencias-nono-cafe");
  });

  test("corta en un límite de palabra a ~50 caracteres", () => {
    const name = suggestedBranch(
      issue(
        "ENG-9157",
        "Dashboard provisional reports endpoints for every single organization",
      ),
    );
    expect(name).toBe("eng-9157-dashboard-provisional-reports-endpoints");
    expect(name.length).toBeLessThanOrEqual(50);
  });
});

describe("issueBranch", () => {
  let store: Store;
  let dir: string;
  beforeEach(() => {
    store = openStore({ path: ":memory:" });
    store.db.$client.exec("PRAGMA foreign_keys = OFF");
    dir = mkdtempSync(join(tmpdir(), "clanker-branch-name-"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function addRun(
    id: string,
    subjectId: string,
    params: Record<string, unknown>,
    startedAt = 1,
    status: "done" | "failed" | "canceled" = "done",
  ) {
    store.db
      .insert(runs)
      .values({
        id: id as RunId,
        subjectType: "issue",
        subjectId,
        flowDefId: "f",
        flowVersion: 1,
        roles: {},
        lane: "dev",
        status,
        writes: true,
        params,
        rounds: {},
        startedAt,
      })
      .run();
  }

  test("sin choque, el sugerido", async () => {
    expect(
      await issueBranch(store, issue("ENG-1", "Cambio uno"), undefined),
    ).toBe("eng-1-cambio-uno");
  });

  test("si lo tiene otra issue (una corrida suya), agrega -2 y -3", async () => {
    addRun("run_1", "iss_other", { branch: "eng-1-cambio-uno" });
    addRun("run_2", "iss_other2", { branch: "eng-1-cambio-uno-2" });
    expect(
      await issueBranch(store, issue("ENG-1", "Cambio uno"), undefined),
    ).toBe("eng-1-cambio-uno-3");
  });

  test("si ya existe en el repo, local o en origin, agrega el sufijo", async () => {
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x",
    );
    git("branch", "eng-1-cambio-uno");
    git("update-ref", "refs/remotes/origin/eng-1-cambio-uno-2", "HEAD");
    expect(await issueBranch(store, issue("ENG-1", "Cambio uno"), dir)).toBe(
      "eng-1-cambio-uno-3",
    );
  });

  test("reanudar reusa el nombre guardado de la issue, aunque el sugerido haya cambiado", async () => {
    addRun("run_1", "iss_ENG-1", { branch: "eng-1-nombre-viejo" }, 1);
    expect(
      await issueBranch(store, issue("ENG-1", "Otro título"), undefined),
    ).toBe("eng-1-nombre-viejo");
  });

  test("una corrida vieja sin params.branch no cuenta: se calcula el nombre nuevo", async () => {
    addRun("run_1", "iss_ENG-1", { repo: "r" });
    expect(
      await issueBranch(store, issue("ENG-1", "Cambio uno"), undefined),
    ).toBe("eng-1-cambio-uno");
  });

  describe("corridas canceladas o fallidas", () => {
    const gitIn = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
    const initRepo = () => {
      gitIn("init", "-q", "-b", "main");
      gitIn(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "x",
      );
    };

    test("una cancelada o fallida cuya branch no existe en el repo no reserva su nombre", async () => {
      initRepo();
      addRun("run_1", "iss_other", { branch: "eng-1-cambio-uno" }, 1, "failed");
      addRun(
        "run_2",
        "iss_other2",
        { branch: "eng-1-cambio-uno-2" },
        1,
        "canceled",
      );
      expect(await issueBranch(store, issue("ENG-1", "Cambio uno"), dir)).toBe(
        "eng-1-cambio-uno",
      );
      expect(
        await freshIssueBranch(store, issue("ENG-1", "Cambio uno"), dir),
      ).toBe("eng-1-cambio-uno");
    });

    test("si la branch llegó al remoto sigue reservada, y una corrida terminada la reserva siempre", async () => {
      initRepo();
      gitIn("update-ref", "refs/remotes/origin/eng-1-cambio-uno", "HEAD");
      addRun("run_1", "iss_other", { branch: "eng-1-cambio-uno" }, 1, "failed");
      addRun(
        "run_2",
        "iss_other2",
        { branch: "eng-1-cambio-uno-2" },
        1,
        "done",
      );
      expect(await issueBranch(store, issue("ENG-1", "Cambio uno"), dir)).toBe(
        "eng-1-cambio-uno-3",
      );
    });
  });
});
