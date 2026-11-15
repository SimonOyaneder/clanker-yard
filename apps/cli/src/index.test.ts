import { expect, test } from "vitest";
import { name } from "./index";

test("exporta el nombre del paquete", () => {
  expect(name).toBe("@clanker/cli");
});
