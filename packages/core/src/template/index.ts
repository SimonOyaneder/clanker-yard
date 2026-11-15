import { flows } from "./flows";
import { profiles } from "./profiles";
import { roles } from "./roles";

/**
 * La plantilla incluida "equipo clanker-loop": los bodies de las defs de kind `role`, `profile` y `flow`,
 * por slug. Quien arranque el core guarda roles y perfiles con `defs.save` y los flujos con `flows.save` (que valida), en el scope `builtin`.
 */
export const clankerLoopTemplate = { roles, profiles, flows };
