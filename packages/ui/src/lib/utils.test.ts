import { expect, test } from "vitest";
import { cn } from "@/lib/utils";

test("cn junta clases y deja ganar a la última de Tailwind", () => {
  expect(cn("px-2", false && "hidden", "px-4")).toBe("px-4");
});
