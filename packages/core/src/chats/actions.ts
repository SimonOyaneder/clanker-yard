import { ChatId } from "@clanker/api";
import { and, desc, eq } from "drizzle-orm";
import * as z from "zod";
import { PermanentActionError, type ActionCtx, type ActionDef } from "../flows/catalog";
import { GitError } from "../git/git";
import { applyThreeWay, diffBetween } from "../git/tree";
import { prById } from "../github/pr-rows";
import { prChatProposals } from "../store/schema";
import type { Store } from "../store/store";
import { excerpt } from "../workspaces/exec";
import { WorkspaceOutput, type Workspaces } from "../workspaces/workspaces";

const ApplyArgs = z.object({ ws: WorkspaceOutput, chatId: ChatId, rev: z.int().positive() });

/**
 * `chat.applyProposal`: deja en el worktree del PR, sin commitear, el cambio de la propuesta `rev` del chat (el diff de
 * su `base_sha` a su snapshot, con `apply --3way`). Outcomes:
 * - `ok` (output `files`, los archivos que cambió, y `head`, la punta sobre la que se aplicó);
 * - `stale`: la propuesta ya no es la vigente del chat, o el PR avanzó desde su `base_sha` y el cambio no calza;
 * - `conflict` (output `files` y `failures`): no calzó sobre la misma punta (el worktree tenía otra cosa).
 * Con `stale` o `conflict` el worktree queda como estaba. Va en un `ctx.once`: un reintento tras un corte no aplica dos
 * veces.
 */
export function chatApplyProposalAction({ store, workspaces }: { store: Store; workspaces: Pick<Workspaces, "git"> }): ActionDef<typeof ApplyArgs> {
  return {
    name: "chat.applyProposal",
    args: ApplyArgs,
    outcomes: ["ok", "conflict", "stale"],
    effects: "local",
    run: ({ ws, chatId, rev }, ctx: ActionCtx) =>
      ctx.once("apply", async () => {
        const latest = store.db.select().from(prChatProposals).where(eq(prChatProposals.chatId, chatId)).orderBy(desc(prChatProposals.rev)).limit(1).get();
        const proposal = store.db.select().from(prChatProposals).where(and(eq(prChatProposals.chatId, chatId), eq(prChatProposals.rev, rev))).get();
        if (!proposal) throw new PermanentActionError(`El chat ${chatId} no tiene la propuesta ${rev}.`);
        if (latest?.rev !== rev || (proposal.status !== "applying" && proposal.status !== "draft")) {
          return { outcome: "stale", output: { reason: `La propuesta ${rev} ya no es la vigente del chat.` } };
        }
        const inWorktree = (...args: string[]) => workspaces.git(ws, ...args);
        const status = (await inWorktree("status", "--porcelain", "--untracked-files=all")).trim();
        if (status !== "") {
          throw new PermanentActionError(`El worktree de ${ws.branch} tiene cambios sin commitear que no son de la propuesta: revísalo antes de aplicar.`);
        }
        const head = (await inWorktree("rev-parse", "HEAD")).trim();
        const patch = await diffBetween(ws.path, proposal.baseSha, proposal.snapshotSha);
        const files = proposal.files.map((file) => file.path);
        const applied = await applyThreeWay(inWorktree, patch);
        if (!applied.ok) {
          const unmerged = (await inWorktree("diff", "--name-only", "-z", "--diff-filter=U")).split("\0").filter(Boolean);
          await inWorktree("reset", "--quiet", "--hard", "HEAD");
          await inWorktree("clean", "--quiet", "--force", "-d");
          const conflicted = unmerged.length > 0 ? unmerged : applied.unapplied.length > 0 ? applied.unapplied : files;
          const failures = excerpt(applied.error instanceof GitError ? applied.error.output : String(applied.error));
          if (head !== proposal.baseSha) {
            return { outcome: "stale", output: { reason: `El PR avanzó de ${proposal.baseSha.slice(0, 7)} a ${head.slice(0, 7)} y la propuesta ya no calza en ${conflicted.join(", ")}.`, files: conflicted, failures } };
          }
          return { outcome: "conflict", output: { files: conflicted, failures } };
        }
        await inWorktree("reset", "--quiet");
        return { outcome: "ok", output: { files, head } };
      }),
  };
}

const WsArgs = z.object({ ws: WorkspaceOutput });

/** `chat.revert`: descarta lo que quedó sin commitear en el worktree del PR (una propuesta que no pasó los checks). */
export function chatRevertAction({ workspaces }: { workspaces: Pick<Workspaces, "git"> }): ActionDef<typeof WsArgs> {
  return {
    name: "chat.revert",
    args: WsArgs,
    outcomes: ["ok"],
    effects: "local",
    async run({ ws }) {
      await workspaces.git(ws, "reset", "--quiet", "--hard", "HEAD");
      await workspaces.git(ws, "clean", "--quiet", "--force", "-d");
      return { outcome: "ok" };
    },
  };
}

const PrArgs = z.object({ prId: z.string().min(1) });

/** `chat.prState`: en qué quedó el PR tras aplicar (`draft` pide review del bot; `ready` y `local` terminan). */
export function chatPrStateAction({ store }: { store: Store }): ActionDef<typeof PrArgs> {
  return {
    name: "chat.prState",
    args: PrArgs,
    outcomes: ["draft", "ready", "local"],
    effects: "local",
    async run({ prId }) {
      const pr = prById(store.db, prId);
      if (!pr) throw new PermanentActionError(`No existe el PR ${prId}.`);
      return { outcome: pr.state === "local" ? "local" : pr.isDraft ? "draft" : "ready" };
    },
  };
}
