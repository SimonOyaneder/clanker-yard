import { Effort } from "@clanker/api";
import { expect, test } from "vitest";
import { profiles } from "../../template/profiles";
import { CLAUDE_OPTIONS } from "./models";

test("ofrece todos los modelos y esfuerzos que usan los perfiles de la plantilla", () => {
  const models = new Set(CLAUDE_OPTIONS.models.map((m) => m.id));
  for (const profile of Object.values(profiles)) {
    for (const spec of Object.values(profile.roles)) {
      expect(models.has(spec.model)).toBe(true);
    }
  }
});

test("ofrece cada esfuerzo del SDK una vez", () => {
  expect(CLAUDE_OPTIONS.efforts.map((e) => e.id)).toEqual(Effort.options);
});
