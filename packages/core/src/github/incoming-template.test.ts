import { expect, test } from "vitest";
import { incomingTemplate } from "./incoming-template";

test("los roles entrantes solo reciben herramientas de lectura y no cargan configuración del proyecto revisado", () => {
  for (const role of Object.values(incomingTemplate.roles)) {
    expect(role.tools).toEqual({ allow: ["Read", "Grep", "Glob"] });
    expect(role.context).toContainEqual({ kind: "native", sources: [], skills: [] });
    expect(role.hooks).not.toBe(true);
  }
});
