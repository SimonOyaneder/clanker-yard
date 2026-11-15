import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Connections } from "../connections/connections";
import type { Askpass } from "./askpass";

const execFileAsync = promisify(execFile);

/**
 * Lo único que git hereda del entorno del core, que puede traer `GH_TOKEN` y otros tokens de la shell
 * que lanzó la app. Los hooks del repo los escribe el agente y ven este entorno.
 */
const INHERITED_ENV = ["PATH", "HOME", "USER", "LANG", "TMPDIR", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"];

/**
 * El fetch no corre hooks del repo (`reference-transaction`, `pre-auto-gc`): contra un repo público
 * git no pide credenciales y un hook podría cambiar el ticket intacto por la contraseña.
 */
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

/** `unauthorized`: GitHub respondió 401 y la conexión quedó revocada. `lease-rejected`: el remoto ya no está donde el core creía. */
export type PushOutcome = "ok" | "lease-rejected" | "unauthorized";
export type FetchOutcome = "ok" | "unauthorized";

export interface RemoteTarget {
  cwd: string;
  /** El remoto como URL explícita (`https://github.com/<owner>/<repo>.git`), nunca el nombre `origin`. */
  url: string;
  /** La cuenta de GitHub cuyo token autentica. */
  account: string;
}

export interface PushRequest extends RemoteTarget {
  branch: string;
  /** El commit que debe quedar en `refs/heads/<branch>`. */
  sha: string;
  /** Lo último que el core sabe que hay en el remoto; `null` si la branch no debería existir. */
  expectedRemoteSha: string | null;
}

/**
 * Habla con el remoto de git con el token de una conexión, entregado por `GIT_ASKPASS`. Es el único
 * lugar que corre `git push` y `git fetch` contra un remoto.
 */
export interface GitRemote {
  /**
   * `--force-with-lease` contra `expectedRemoteSha`. Si el lease falla pero el remoto ya tiene `sha`
   * (un push anterior que no alcanzó a registrarse), es `ok`. Un lease rechazado no se reintenta.
   */
  push(request: PushRequest): Promise<PushOutcome>;
  /** Trae todas las branches a `refs/remotes/origin/*`. */
  fetch(target: RemoteTarget): Promise<FetchOutcome>;
}

export interface GitRemoteOptions {
  askpass: Askpass;
  connections: Pick<Connections, "token" | "markRevoked">;
}

export function createGitRemote({ askpass, connections }: GitRemoteOptions): GitRemote {
  /** `credential.helper=` vacío: el Keychain no puede contestar con otra cuenta. */
  async function run({ cwd, url, account }: RemoteTarget, args: string[]) {
    const token = await connections.token("github", account);
    const session = await askpass.issue({ username: account, password: token }, url);
    try {
      const { stdout } = await execFileAsync("git", ["-c", "credential.helper=", ...args], {
        cwd,
        env: { ...inheritedEnv(), ...session.env },
        encoding: "utf8",
      });
      return { ok: true as const, stdout: stdout.trimEnd() };
    } catch (error) {
      const { stderr = "" } = error as { stderr?: string };
      if (UNAUTHORIZED.test(stderr)) {
        connections.markRevoked("github", account, "core");
        return { ok: false as const, reason: "unauthorized" as const, stderr };
      }
      return { ok: false as const, reason: "failed" as const, stderr };
    } finally {
      session.revoke();
    }
  }

  function failure(target: RemoteTarget, args: string[], stderr: string): Error {
    return new Error(`git ${args.join(" ")} falló en ${target.cwd}: ${stderr.trim()}`);
  }

  return {
    async push(request) {
      const { url, branch, sha, expectedRemoteSha } = request;
      const ref = `refs/heads/${branch}`;
      const args = ["push", `--force-with-lease=${ref}:${expectedRemoteSha ?? ""}`, url, `${sha}:${ref}`];
      const pushed = await run(request, args);
      if (pushed.ok) return "ok";
      if (pushed.reason === "unauthorized") return "unauthorized";
      if (!STALE_LEASE.test(pushed.stderr)) throw failure(request, args, pushed.stderr);

      const lsArgs = ["ls-remote", url, ref];
      const listed = await run(request, lsArgs);
      if (!listed.ok) {
        if (listed.reason === "unauthorized") return "unauthorized";
        throw failure(request, lsArgs, listed.stderr);
      }
      return listed.stdout.split(/\s+/)[0] === sha ? "ok" : "lease-rejected";
    },

    async fetch(target) {
      const args = [...NO_HOOKS, "fetch", "--no-tags", target.url, "+refs/heads/*:refs/remotes/origin/*"];
      const fetched = await run(target, args);
      if (fetched.ok) return "ok";
      if (fetched.reason === "unauthorized") return "unauthorized";
      throw failure(target, args, fetched.stderr);
    },
  };
}

function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

const STALE_LEASE = /\(stale info\)/;
/** Con credenciales que GitHub rechaza, git termina en "Authentication failed" tras el 401. */
const UNAUTHORIZED = /Authentication failed|error: 401|HTTP 401/;
