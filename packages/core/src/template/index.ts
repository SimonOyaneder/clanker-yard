import { profiles } from "./profiles";
import { roles } from "./roles";

/**
 * La plantilla incluida "equipo clanker-loop": los bodies de las defs de kind `role` y `profile`,
 * por slug. Quien arranque el core los guarda con `defs.save` en el scope `builtin`.
 */
export const clankerLoopTemplate = { roles, profiles };
