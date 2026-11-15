import { type ContractRouterClient, isContractProcedure } from "@orpc/contract";
import { describe, expect, expectTypeOf, test } from "vitest";
import { type Contract, type Event, contract } from "./index";

describe("contrato", () => {
  test("exporta los routers system y events con sus procedimientos", () => {
    expect(Object.keys(contract).sort()).toEqual(["connections", "events", "system"]);
    expect(Object.keys(contract.connections)).toEqual(["list"]);
    expect(Object.keys(contract.system).sort()).toEqual(["health", "info", "shutdown"]);
    expect(Object.keys(contract.events).sort()).toEqual(["list", "stream"]);
    for (const procedure of [...Object.values(contract.system), ...Object.values(contract.events)]) {
      expect(isContractProcedure(procedure)).toBe(true);
    }
  });

  test("events.list aplica los defaults y valida los límites", async () => {
    const schema = contract.events.list["~orpc"].inputSchema!["~standard"];
    expect(await schema.validate({})).toMatchObject({ value: { after: 0, limit: 100, filter: {} } });
    expect(await schema.validate({ limit: 501 })).toHaveProperty("issues");
  });

  test("los tipos del cliente salen del contrato", () => {
    type Client = ContractRouterClient<Contract>;
    expectTypeOf<Awaited<ReturnType<Client["system"]["health"]>>["apiMajor"]>().toBeNumber();
    expectTypeOf<Awaited<ReturnType<Client["events"]["list"]>>>().toEqualTypeOf<Event[]>();
    expectTypeOf<Parameters<Client["system"]["shutdown"]>[0]>().toEqualTypeOf<{ drain: boolean }>();
  });
});
