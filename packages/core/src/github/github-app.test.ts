import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { PERMISSIONS } from "./pat";

const docs = new URL("../../../../docs/", import.meta.url);
const manifest: Record<string, unknown> = JSON.parse(readFileSync(new URL("github-app-manifest.json", docs), "utf8"));

// Las claves que documenta GitHub para un manifiesto (registering-a-github-app-from-a-manifest).
const MANIFEST_KEYS = [
  "name",
  "url",
  "hook_attributes",
  "redirect_url",
  "callback_urls",
  "setup_url",
  "description",
  "public",
  "default_events",
  "default_permissions",
  "request_oauth_on_install",
  "setup_on_update",
];

describe("manifiesto de la GitHub App (docs/github-app-manifest.json)", () => {
  test("solo usa claves que GitHub define y trae las obligatorias", () => {
    expect(Object.keys(manifest).filter((key) => !MANIFEST_KEYS.includes(key))).toEqual([]);
    expect(manifest.url).toMatch(/^https:\/\/github\.com\/SimonOyaneder\/clanker-yard$/);
    expect(manifest.redirect_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
  });

  test("pide los mismos permisos que los de Clanker Yard (`PERMISSIONS`)", () => {
    const pat = Object.fromEntries(PERMISSIONS.map(({ name, access }) => [name, access]));
    expect(manifest.default_permissions).toEqual(pat);
  });

  test("es privada y sin webhooks ni eventos", () => {
    expect(manifest.public).toBe(false);
    expect(manifest.hook_attributes).toBeUndefined();
    expect(manifest.default_events).toBeUndefined();
  });

  test("la guía existe y apunta al manifiesto y a la variable del client_id", () => {
    const guide = readFileSync(new URL("github-app.md", docs), "utf8");
    expect(guide).toContain("docs/github-app-manifest.json");
    expect(guide).toContain("CLANKER_GITHUB_APP_CLIENT_ID");
    expect(guide).toContain("Enable Device Flow");
  });
});
