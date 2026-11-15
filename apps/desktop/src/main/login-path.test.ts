import { expect, test } from "vitest";
import { withLoginPath } from "./login-path";

const marked = (path: string) => `__clanker_path_start__${path}__clanker_path_end__`;

test("suma el PATH de la shell de login al actual sin repetir carpetas", () => {
  const run = () => `ruido del .zshrc\n${marked("/Users/s/.local/bin:/opt/homebrew/bin:/usr/bin")}más ruido`;
  expect(withLoginPath({ SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" }, run)).toBe("/Users/s/.local/bin:/opt/homebrew/bin:/usr/bin:/bin");
});

test("pide el PATH a la shell del usuario, interactiva y de login", () => {
  const calls: Array<[string, string[]]> = [];
  withLoginPath({ SHELL: "/opt/homebrew/bin/fish", PATH: "/usr/bin" }, (shell, args) => (calls.push([shell, args]), marked("/usr/bin")));
  expect(calls[0]?.[0]).toBe("/opt/homebrew/bin/fish");
  expect(calls[0]?.[1][0]).toBe("-ilc");
});

test("si la shell falla o no imprime las marcas deja el PATH actual", () => {
  const env = { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" };
  expect(withLoginPath(env, () => "sin marcas")).toBe("/usr/bin:/bin");
  expect(
    withLoginPath(env, () => {
      throw new Error("timeout");
    }),
  ).toBe("/usr/bin:/bin");
});
