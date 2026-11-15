import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ArtifactHash, ArtifactKind } from "@clanker/api";
import { and, eq, lt, notExists } from "drizzle-orm";
import { artifactRefs, artifacts as artifactsTable } from "../store/schema";
import type { Store } from "../store/store";

/** Hasta este tamaño (inclusive) el contenido vive en la base; más grande, en un archivo. */
export const INLINE_MAX_BYTES = 64 * 1024;
export const GC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** El hash de un contenido: su identidad como artefacto. */
export const hashOf = (bytes: Uint8Array): ArtifactHash => createHash("sha256").update(bytes).digest("hex");

export interface Artifact {
  hash: ArtifactHash;
  kind: ArtifactKind;
  mime: string;
  size: number;
  content: Uint8Array;
}

/** Quién usa el artefacto y para qué, por ejemplo `{ type: "step_run", id: "stp_…", role: "output" }`. */
export interface ArtifactOwner {
  type: string;
  id: string;
  role: string;
}

export interface ArtifactsOptions {
  store: Store;
  /** Carpeta de los artefactos grandes (`<dataDir>/artifacts`). Se crea al guardar el primero. */
  dir: string;
  now?: () => number;
}

export interface Artifacts {
  /**
   * Guarda el contenido y devuelve su hash. El mismo contenido se guarda una sola vez: un `put`
   * repetido conserva el `kind` y el `mime` de la primera vez y solo renueva el plazo del GC.
   * Un string se guarda como UTF-8 (`text/plain`); sin `mime`, los bytes son `application/octet-stream`.
   */
  put(content: string | Uint8Array, kind: ArtifactKind, opts?: { mime?: string }): ArtifactHash;
  /** `undefined` si no existe ese hash. Falla si la fila existe pero su archivo desapareció. */
  get(hash: ArtifactHash): Artifact | undefined;
  /** Registra que `owner` usa el artefacto. Idempotente. Falla si el hash no existe. */
  ref(hash: ArtifactHash, owner: ArtifactOwner): void;
  /** Borra los artefactos sin refs cuyo último `put` fue hace más de 30 días. Devuelve cuántos. */
  gc(): number;
}

export function createArtifacts({ store, dir, now = Date.now }: ArtifactsOptions): Artifacts {
  const pathOf = (hash: string) => join(dir, hash.slice(0, 2), hash.slice(2));

  return {
    put(content, kind, opts = {}) {
      const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
      const hash = hashOf(bytes);
      const inline = bytes.byteLength <= INLINE_MAX_BYTES;
      const mime =
        opts.mime ?? (typeof content === "string" ? "text/plain; charset=utf-8" : "application/octet-stream");

      // El archivo va antes que la fila: una fila sin archivo sería un artefacto roto, y un archivo
      // sin fila (el proceso murió entre los dos pasos) es el mismo contenido y el próximo put lo reutiliza.
      if (!inline) writeAtomically(pathOf(hash), bytes);

      store.tx((tx) => {
        tx.db
          .insert(artifactsTable)
          .values({
            hash,
            kind,
            mime,
            size: bytes.byteLength,
            body: inline ? Buffer.from(bytes) : null,
            lastPutAt: now(),
          })
          .onConflictDoUpdate({ target: artifactsTable.hash, set: { lastPutAt: now() } })
          .run();
      });
      return hash;
    },

    get(hash) {
      const row = store.db.select().from(artifactsTable).where(eq(artifactsTable.hash, hash)).get();
      if (!row) return undefined;
      const { kind, mime, size, body } = row;
      return { hash, kind, mime, size, content: body ?? readFromDisk(pathOf(hash), hash) };
    },

    ref(hash, owner) {
      store.tx((tx) => {
        const exists = tx.db
          .select({ hash: artifactsTable.hash })
          .from(artifactsTable)
          .where(eq(artifactsTable.hash, hash))
          .get();
        if (!exists) {
          throw new Error(`No existe el artefacto ${hash}: guárdalo con put antes de referenciarlo.`);
        }
        tx.db
          .insert(artifactRefs)
          .values({ hash, ownerType: owner.type, ownerId: owner.id, role: owner.role })
          .onConflictDoNothing()
          .run();
      });
    },

    gc() {
      const cutoff = now() - GC_MAX_AGE_MS;
      const removed = store.tx((tx) =>
        tx.db
          .delete(artifactsTable)
          .where(
            and(
              lt(artifactsTable.lastPutAt, cutoff),
              notExists(
                tx.db.select().from(artifactRefs).where(eq(artifactRefs.hash, artifactsTable.hash)),
              ),
            ),
          )
          .returning({ hash: artifactsTable.hash, size: artifactsTable.size })
          .all(),
      );
      // Después del commit: si el borrado de un archivo falla queda un archivo huérfano (inofensivo),
      // no una fila que apunta a un archivo inexistente.
      for (const { hash, size } of removed) {
        if (size > INLINE_MAX_BYTES) rmSync(pathOf(hash), { force: true });
      }
      return removed.length;
    },
  };
}

function writeAtomically(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}

function readFromDisk(path: string, hash: string): Uint8Array {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new Error(
      `El artefacto ${hash} está registrado pero no se pudo leer su archivo ${path}: ${String(error)}`,
      { cause: error },
    );
  }
}
