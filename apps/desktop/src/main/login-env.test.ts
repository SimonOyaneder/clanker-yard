import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loginEnv } from "./login-env";

const marked = (path: string, lang = "") => `__clanker_env_start__${path}\n__clanker_env_sep__${lang}\n__clanker_env_end__`;

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "clanker-login-env-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Una shell de login de mentira: fija su PATH y su LANG, imprime ruido como un .zshrc y corre el comando con `real`. */
function fakeShell(real: string, loginPath: string, lang: string): string {
  const path = join(dir, "shell");
  writeFileSync(path, `#!/bin/sh\necho "ruido del rc"\nPATH='${loginPath}'; LANG='${lang}'; export PATH LANG\nexec ${real} -c "$2"\n`);
  chmodSync(path, 0o755);
  return path;
}

// `zsh -f`: sin el ~/.zshenv de quien corre el test.
// zsh no viene en todos los runners de la CI (Ubuntu no lo trae): se prueba con las shells que existan.
test.each(["/bin/sh", "/bin/zsh -f"].filter((shell) => existsSync(shell.split(" ")[0]!)))("con %s de verdad, suma el PATH de la shell de login al actual y toma su LANG", (real) => {
  const shell = fakeShell(real, "/login/bin:/usr/bin:/bin", "es_CL.UTF-8");
  expect(loginEnv({ SHELL: shell, PATH: "/usr/bin:/sbin" })).toEqual({ PATH: "/login/bin:/usr/bin:/bin:/sbin", LANG: "es_CL.UTF-8" });
});

test("suma el PATH de la shell de login al actual sin repetir carpetas", () => {
  const run = () => `ruido del .zshrc\n${marked("/Users/s/.local/bin:/opt/homebrew/bin:/usr/bin", "C.UTF-8")}más ruido`;
  expect(loginEnv({ SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" }, run)).toEqual({ PATH: "/Users/s/.local/bin:/opt/homebrew/bin:/usr/bin:/bin", LANG: "C.UTF-8" });
});

test("descarta las carpetas relativas y vacías, de la shell y del PATH actual", () => {
  const run = () => marked("./bin:bin::/opt/homebrew/bin");
  expect(loginEnv({ SHELL: "/bin/zsh", PATH: ".:/usr/bin" }, run).PATH).toBe("/opt/homebrew/bin:/usr/bin");
});

test("un LANG que ya viene se respeta, y sin LANG en ningún lado queda en UTF-8", () => {
  expect(loginEnv({ SHELL: "/bin/zsh", PATH: "/usr/bin", LANG: "es_ES.UTF-8" }, () => marked("/usr/bin", "C.UTF-8")).LANG).toBe("es_ES.UTF-8");
  expect(loginEnv({ SHELL: "/bin/zsh", PATH: "/usr/bin" }, () => marked("/usr/bin")).LANG).toBe("en_US.UTF-8");
});

test("pide el entorno a la shell del usuario, interactiva y de login", () => {
  const calls: Array<[string, string[]]> = [];
  loginEnv({ SHELL: "/opt/homebrew/bin/fish", PATH: "/usr/bin" }, (shell, args) => (calls.push([shell, args]), marked("/usr/bin")));
  expect(calls[0]?.[0]).toBe("/opt/homebrew/bin/fish");
  expect(calls[0]?.[1][0]).toBe("-ilc");
});

test("si la shell falla o no imprime las marcas deja el PATH actual", () => {
  const env = { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" };
  expect(loginEnv(env, () => "sin marcas")).toEqual({ PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" });
  expect(
    loginEnv(env, () => {
      throw new Error("timeout");
    }),
  ).toEqual({ PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" });
});
