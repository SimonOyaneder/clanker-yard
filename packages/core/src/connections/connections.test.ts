import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createFileSecrets } from "../secrets/encrypted-file";
import type { Secrets } from "../secrets/secrets";
import { openStore, type Store } from "../store/store";
import { createConnections, type ConnectInput, type Connections } from "./connections";

/** Fijo: los vencimientos de los tests no deben depender del reloj real. */
const NOW = 1_700_000_000_000;
const TOKEN = "ghp_UNIQUE-secret-token-0123456789";
const github: Omit<ConnectInput, "token" | "expiresAt"> = {
  provider: "github",
  account: "simon",
  scopes: ["contents", "pull_requests"],
};

let dir: string;
let store: Store;
let secrets: Secrets;
let connections: Connections;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clanker-connections-"));
  store = openStore({ path: join(dir, "clanker.db") });
  secrets = createFileSecrets({ dir: join(dir, "secrets") });
  connections = createConnections(store, secrets, { now: () => NOW });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("connect", () => {
  test("la cuenta aparece en list sin el token, y el core puede leer el token", async () => {
    const connection = await connections.connect(
      { ...github, token: TOKEN, expiresAt: 1_800_000_000_000 },
      "ui",
    );

    expect(connection).toEqual({ ...github, status: "active", expiresAt: 1_800_000_000_000 });
    expect(connections.list()).toEqual([connection]);
    expect(await connections.token("github", "simon")).toBe(TOKEN);
  });

  test("sin expiresAt la cuenta no lo trae", async () => {
    await connections.connect({ ...github, token: TOKEN }, "ui");
    expect(connections.list()[0]).not.toHaveProperty("expiresAt");
  });

  test("conectar de nuevo la misma cuenta reemplaza token, scopes y vencimiento", async () => {
    await connections.connect({ ...github, token: TOKEN, expiresAt: 1 }, "ui");
    await connections.connect({ ...github, scopes: ["contents"], token: "ghp_nuevo" }, "cli");

    expect(connections.list()).toEqual([
      { provider: "github", account: "simon", scopes: ["contents"], status: "active" },
    ]);
    expect(await connections.token("github", "simon")).toBe("ghp_nuevo");
  });

  test("list ordena por proveedor y cuenta, y dos cuentas del mismo proveedor conviven", async () => {
    await connections.connect({ provider: "linear", account: "simon", scopes: [], token: "lin_1" }, "ui");
    await connections.connect({ ...github, account: "otra", token: "ghp_otra" }, "ui");
    await connections.connect({ ...github, token: TOKEN }, "ui");

    expect(connections.list().map((c) => `${c.provider}/${c.account}`)).toEqual([
      "github/otra",
      "github/simon",
      "linear/simon",
    ]);
    expect(await connections.token("github", "otra")).toBe("ghp_otra");
    expect(await connections.token("github", "simon")).toBe(TOKEN);
  });

  test("rechaza una cuenta o un token vacíos sin guardar nada", async () => {
    await expect(connections.connect({ ...github, account: "", token: TOKEN }, "ui")).rejects.toThrow(/no vacíos/);
    await expect(connections.connect({ ...github, token: "" }, "ui")).rejects.toThrow(/no vacíos/);
    expect(connections.list()).toEqual([]);
    expect(store.events.since(0)).toEqual([]);
  });

  test("si el almacén de secretos falla no queda ni la cuenta ni el evento", async () => {
    const broken: Secrets = { ...secrets, set: () => Promise.reject(new Error("llavero bloqueado")) };
    await expect(createConnections(store, broken).connect({ ...github, token: TOKEN }, "ui")).rejects.toThrow(
      "llavero bloqueado",
    );
    expect(connections.list()).toEqual([]);
    expect(store.events.since(0)).toEqual([]);
  });
});

describe("disconnect", () => {
  test("borra la cuenta y el token", async () => {
    await connections.connect({ ...github, token: TOKEN }, "ui");
    await connections.disconnect("github", "simon", "ui");

    expect(connections.list()).toEqual([]);
    expect(await secrets.get("connection:github:simon")).toBeUndefined();
    await expect(connections.token("github", "simon")).rejects.toThrow(/conéctala primero/);
  });

  test("desconectar una cuenta que no existe no hace nada ni emite", async () => {
    await connections.disconnect("github", "nadie", "ui");
    expect(store.events.since(0)).toEqual([]);
  });

  test("si borrar el token falla la cuenta sigue a la vista para reintentar", async () => {
    await connections.connect({ ...github, token: TOKEN }, "ui");
    const broken: Secrets = { ...secrets, delete: () => Promise.reject(new Error("llavero bloqueado")) };

    await expect(createConnections(store, broken).disconnect("github", "simon", "ui")).rejects.toThrow(
      "llavero bloqueado",
    );
    expect(connections.list()).toHaveLength(1);
  });
});

describe("markRevoked", () => {
  test("deja la cuenta revocada y emite connection.changed una sola vez", async () => {
    await connections.connect({ ...github, token: TOKEN }, "ui");

    connections.markRevoked("github", "simon", "core");
    connections.markRevoked("github", "simon", "core");

    expect(connections.list()[0]?.status).toBe("revoked");
    expect(store.events.since(0).filter((e) => e.payload.status === "revoked")).toHaveLength(1);
  });

  test("conectar de nuevo la deja activa", async () => {
    await connections.connect({ ...github, token: TOKEN }, "ui");
    connections.markRevoked("github", "simon", "core");

    await connections.connect({ ...github, token: `${TOKEN}-nuevo` }, "ui");

    expect(connections.list()[0]?.status).toBe("active");
  });

  test("una cuenta que no existe no hace nada", () => {
    connections.markRevoked("github", "nadie", "core");

    expect(store.events.since(0)).toEqual([]);
  });
});

describe("token", () => {
  test("si la cuenta existe pero falta su secreto, dice cómo repararlo", async () => {
    await connections.connect({ ...github, token: TOKEN }, "ui");
    await secrets.delete("connection:github:simon");

    await expect(connections.token("github", "simon")).rejects.toThrow(/desconecta la cuenta y vuelve a conectarla/);
  });
});

describe("connection.changed", () => {
  test("se emite al conectar y al desconectar, con el origen de la llamada", async () => {
    await connections.connect({ ...github, token: TOKEN }, "ui");
    await connections.disconnect("github", "simon", "cli");

    expect(store.events.since(0).map((e) => [e.type, e.origin, e.payload])).toEqual([
      ["connection.changed", "ui", { provider: "github", account: "simon", status: "active" }],
      ["connection.changed", "cli", { provider: "github", account: "simon", status: "disconnected" }],
    ]);
  });
});

describe("sin secretos fuera del almacén", () => {
  test("el valor del token no está en la base, ni en sus archivos WAL, ni en los eventos, ni en list", async () => {
    await connections.connect({ ...github, token: TOKEN, expiresAt: 5 }, "ui");
    await connections.connect({ ...github, token: `${TOKEN}-rotado` }, "ui");

    // Con la base todavía abierta: el contenido puede estar en el WAL.
    const dbFiles = readdirSync(dir).filter((f) => f.startsWith("clanker.db"));
    expect(dbFiles).toContain("clanker.db");
    for (const file of dbFiles) {
      const bytes = readFileSync(join(dir, file)).toString("latin1");
      expect(bytes, file).not.toContain("UNIQUE-secret-token");
    }
    expect(JSON.stringify(store.events.since(0))).not.toContain("UNIQUE-secret-token");
    expect(JSON.stringify(connections.list())).not.toContain("UNIQUE-secret-token");
  });

  test("la base guarda la ref del secreto, no el valor", async () => {
    await connections.connect({ ...github, token: TOKEN }, "ui");
    const row = store.db.$client.prepare("SELECT secret_ref FROM connections").get();
    expect(row).toEqual({ secret_ref: "connection:github:simon" });
  });
});
