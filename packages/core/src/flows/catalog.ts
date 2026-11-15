import type { FlowDef } from "@clanker/api";
import type { ZodType } from "zod";

// Lo que la validación de un flujo necesita saber de lo que registran otros módulos
// (Workspaces, CodeHost, Tracker, packs, Agents). El motor que ejecuta flujos agrega aquí lo suyo
// (`run`, `key`, `match`, `probe`, timeouts y reintentos) sin tocar a quien valida.

export interface ActionDef {
  name: string;
  args: ZodType;
  outcomes: string[];
  /** `remote`: publica (push, PR, comentarios, tracker). `effects: "local"` en un flujo la rechaza. */
  effects: "local" | "remote";
}

export interface WaitDef {
  name: string;
  args: ZodType;
  outcomes: string[];
}

export interface ConsolidatorDef {
  name: string;
  /** Valida el `args` del `join`; sin esto no se validan. */
  args?: ZodType;
  outcomes: string[];
}

/** Un rol visto desde un flujo: qué modos tiene, qué outcomes da cada uno y qué forma lleva su brief. */
export interface RoleInfo {
  modes: Record<string, { outcomes: string[]; payload?: ZodType }>;
}

export interface Catalog {
  action(name: string): ActionDef | undefined;
  wait(name: string): WaitDef | undefined;
  consolidator(name: string): ConsolidatorDef | undefined;
  role(id: string): RoleInfo | undefined;
  /** El flujo vigente con ese id, para validar llamadas entre flujos. */
  flow(id: string): FlowDef | undefined;
}
