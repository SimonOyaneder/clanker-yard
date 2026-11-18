import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ChatId, type RepoId } from "@clanker/api";
import { and, eq } from "drizzle-orm";
import { githubUnauthorized } from "../breakers/breakers";
import { BadRequestError, NotFoundError } from "../errors/domain";
import { git, tryGit } from "../git/git";
import type { GitIdentityOf } from "../git/identity";
import { applyThreeWay, diffBetween, excludeRunDir, snapshotTree } from "../git/tree";
import type { RepoConfig } from "../repos/repos";
import { chatScratches, pullRequests } from "../store/schema";
import type { Store } from "../store/store";
import { excerpt } from "./exec";
import type { Workspaces } from "./workspaces";

export type ScratchSyncResult =
  | { outcome: "same"; headSha: string }
  | { outcome: "moved"; headSha: string; from: string; backup: string }
  | { outcome: "conflict"; headSha: string; from: string; backup: string; conflicts: string[]; failures: string };

export interface ChatScratch {
  create(repoId: RepoId, chatId: ChatId, headSha: string): Promise<string>;
  sync(chatId: ChatId, newHead: string): Promise<ScratchSyncResult>;
  snapshot(chatId: ChatId, rev: number): Promise<{ ref: string; sha: string; patch: string; files: string[] }>;
  discard(chatId: ChatId): Promise<void>;
  remove(chatId: ChatId): Promise<void>;
  cleanup(): Promise<void>;
}

export function createChatScratch({
  store,
  dataDir,
  repoConfig,
  identityOf,
  workspaces,
  chatOf,
}: {
  store: Store;
  dataDir: string;
  repoConfig: (repoId: RepoId) => RepoConfig;
  identityOf: GitIdentityOf;
  workspaces: Pick<Workspaces, "fetch" | "fetchPr" | "withRepoLock">;
  chatOf: (chatId: ChatId) => { prId: string; active: boolean } | undefined;
}): ChatScratch {
  const pathOf = (chatId: ChatId) => join(dataDir, "chats", chatId);
  const refsOf = (chatId: ChatId) => `refs/clanker/chat/${chatId}/`;
  const chatLocks = new Map<ChatId, Promise<unknown>>();

  async function withChatLock<T>(chatId: ChatId, fn: () => Promise<T>): Promise<T> {
    const result = (chatLocks.get(chatId) ?? Promise.resolve()).then(fn);
    const tail = result.catch(() => undefined);
    chatLocks.set(chatId, tail);
    try {
      return await result;
    } finally {
      if (chatLocks.get(chatId) === tail) chatLocks.delete(chatId);
    }
  }

  function rowOf(chatId: ChatId) {
    const row = store.db.select().from(chatScratches).where(eq(chatScratches.chatId, chatId)).get();
    if (!row) throw new NotFoundError(`No existe el borrador del chat ${chatId}.`);
    return row;
  }

  function prOf(chatId: ChatId, repoId: RepoId) {
    const chat = chatOf(chatId);
    if (!chat) throw new NotFoundError(`No existe el chat ${chatId}.`);
    const pr = store.db.select().from(pullRequests)
      .where(and(eq(pullRequests.id, chat.prId), eq(pullRequests.repoId, repoId))).get();
    if (!pr) throw new NotFoundError(`No existe el PR ${chat.prId} en ${repoId}.`);
    return pr;
  }

  async function fetchPr(repoId: RepoId, pr: typeof pullRequests.$inferSelect, headSha: string): Promise<void> {
    const cfg = repoConfig(repoId);
    if (pr.state !== "local" && cfg.remote) {
      if ((await workspaces.fetch(repoId)) === "unauthorized") {
        throw githubUnauthorized(cfg.remote.account, `traer ${repoId}`);
      }
      if ((await tryGit(cfg.path, ["cat-file", "-e", `${headSha}^{commit}`])) !== undefined) return;
      if ((await workspaces.fetchPr(repoId, pr.number!)) === "unauthorized") {
        throw githubUnauthorized(cfg.remote.account, `traer ${repoId}`);
      }
    }
    if ((await tryGit(cfg.path, ["cat-file", "-e", `${headSha}^{commit}`])) === undefined) {
      throw new BadRequestError(`No se pudo obtener la punta ${headSha} del PR. Reintenta con su punta vigente.`);
    }
  }

  async function saveTree(chatId: ChatId, ref: string, parent: string): Promise<string> {
    const row = rowOf(chatId);
    const path = pathOf(chatId);
    const tree = await snapshotTree(path);
    const identity = await identityOf(row.repoId);
    const sha = await git(path, ["commit-tree", tree, "-p", parent, "-m", `clanker: borrador de ${chatId}`], {
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    });
    await git(path, ["update-ref", ref, sha]);
    return sha;
  }

  async function sync(chatId: ChatId, newHead: string): Promise<ScratchSyncResult> {
    let row = rowOf(chatId);
    if (row.syncTarget !== null && row.syncTarget !== newHead) {
      const pending = await sync(chatId, row.syncTarget);
      if (pending.outcome === "conflict") return pending;
      row = rowOf(chatId);
    }
    const from = row.headSha;
    if (from === newHead && row.syncTarget === null) return { outcome: "same", headSha: newHead };
    await fetchPr(row.repoId, prOf(chatId, row.repoId), newHead);
    const path = pathOf(chatId);
    const backup = `${refsOf(chatId)}sync`;
    if (row.syncTarget === null) {
      await saveTree(chatId, backup, from);
      store.tx(({ db }) => db.update(chatScratches).set({ syncTarget: newHead }).where(eq(chatScratches.chatId, chatId)).run());
    }
    const inWorktree = (...args: string[]) => git(path, args);
    const files = (await inWorktree("diff", "--no-renames", "--name-only", "-z", `${backup}^`, backup)).split("\0").filter(Boolean);
    const deleted = (await inWorktree("diff", "--no-renames", "--name-only", "-z", "--diff-filter=D", `${backup}^`, backup)).split("\0");
    await inWorktree("reset", "--quiet", "--hard", newHead);
    await inWorktree("clean", "--quiet", "--force", "-d");
    const conflicts: string[] = [];
    const failures: string[] = [];
    const groups: string[][] = [];
    for (const file of files) {
      if (deleted.includes(file) && (await tryGit(path, ["cat-file", "-e", `${newHead}:${file}`])) === undefined) continue;
      const group = groups.find((paths) => paths.some((other) => file.startsWith(`${other}/`) || other.startsWith(`${file}/`)));
      if (group) group.push(file);
      else groups.push([file]);
    }
    for (const group of groups) {
      const patch = await diffBetween(path, `${backup}^`, backup, group);
      const applied = await applyThreeWay(inWorktree, patch);
      if (!applied.ok) {
        const unmerged = (await inWorktree("diff", "--name-only", "-z", "--diff-filter=U")).split("\0");
        for (const file of group) {
          if (!unmerged.includes(file)) {
            if (!applied.unapplied.includes(file)) throw applied.error;
            await inWorktree("restore", "--source", backup, "--worktree", "--", `:(literal)${file}`);
          }
          conflicts.push(file);
        }
        failures.push(excerpt(applied.error.output));
      }
      await inWorktree("reset", "--quiet");
    }
    store.tx(({ db }) => db.update(chatScratches).set({ headSha: newHead, syncTarget: null }).where(eq(chatScratches.chatId, chatId)).run());
    if (conflicts.length === 0) return { outcome: "moved", headSha: newHead, from, backup };
    return {
      outcome: "conflict",
      headSha: newHead,
      from,
      backup,
      conflicts,
      failures: [
        `Conflicto en ${conflicts.join(", ")}. El árbol anterior está en ${backup}.`,
        ...failures,
      ].join("\n"),
    };
  }

  async function remove(chatId: ChatId, onlyInactive: boolean): Promise<void> {
    const row = rowOf(chatId);
    const cfg = repoConfig(row.repoId);
    await workspaces.withRepoLock(row.repoId, async () => {
      const path = pathOf(chatId);
      const registered = await git(cfg.path, ["worktree", "list", "--porcelain", "-z"]);
      if (onlyInactive) {
        const chat = chatOf(chatId);
        const pr = chat && store.db.select().from(pullRequests).where(eq(pullRequests.id, chat.prId)).get();
        if (chat?.active && pr && (pr.state === "open" || pr.state === "local")) return;
      }
      if (registered.split("\0").includes(`worktree ${join(realpathSync(dataDir), "chats", chatId)}`)) {
        await git(cfg.path, ["worktree", "remove", "--force", path]);
      }
      const refs = (await git(cfg.path, ["for-each-ref", "--format=%(refname)", refsOf(chatId)])).split("\n").filter(Boolean);
      for (const ref of refs) await git(cfg.path, ["update-ref", "-d", ref]);
      store.tx(({ db }) => db.delete(chatScratches).where(eq(chatScratches.chatId, chatId)).run());
    });
  }

  return {
    create(repoId, chatId, headSha) {
      return withChatLock(chatId, async () => {
        const parsed = ChatId.safeParse(chatId);
        if (!parsed.success) throw new BadRequestError("El id del chat debe tener el prefijo chat_ y un ULID válido.");
        chatId = parsed.data;
        const pr = prOf(chatId, repoId);
        const cfg = repoConfig(repoId);
        await fetchPr(repoId, pr, headSha);
        store.tx(({ db }) => {
          db.insert(chatScratches).values({ chatId, repoId, headSha }).onConflictDoNothing().run();
        });
        const path = pathOf(chatId);
        await workspaces.withRepoLock(repoId, async () => {
          if (!existsSync(path)) {
            mkdirSync(join(dataDir, "chats"), { recursive: true });
            await git(cfg.path, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", path, rowOf(chatId).headSha]);
          }
          await excludeRunDir(path);
        });
        return path;
      });
    },
    sync(chatId, newHead) {
      return withChatLock(chatId, () => sync(chatId, newHead));
    },
    snapshot(chatId, rev) {
      return withChatLock(chatId, async () => {
        const row = rowOf(chatId);
        const ref = `${refsOf(chatId)}p${rev}`;
        const sha = await saveTree(chatId, ref, row.headSha);
        const path = pathOf(chatId);
        const patch = await diffBetween(path, row.headSha, sha);
        const files = (await git(path, ["diff", "--no-renames", "--name-only", "-z", row.headSha, sha])).split("\0").filter(Boolean);
        return { ref, sha, patch, files };
      });
    },
    discard(chatId) {
      return withChatLock(chatId, async () => {
        const row = rowOf(chatId);
        const target = row.syncTarget ?? row.headSha;
        const path = pathOf(chatId);
        await git(path, ["reset", "--quiet", "--hard", target]);
        await git(path, ["clean", "--quiet", "--force", "-d"]);
        store.tx(({ db }) => db.update(chatScratches).set({ headSha: target, syncTarget: null }).where(eq(chatScratches.chatId, chatId)).run());
      });
    },
    remove(chatId) {
      return withChatLock(chatId, () => remove(chatId, false));
    },
    async cleanup() {
      const rows = store.db.select().from(chatScratches).all();
      const failures: Error[] = [];
      for (const scratch of rows) {
        try {
          await withChatLock(scratch.chatId, () => remove(scratch.chatId, true));
        } catch (error) {
          failures.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, `No se pudieron borrar los borradores de chats: ${failures.map((error) => error.message).join("; ")}`);
      }
    },
  };
}
