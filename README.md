# Clanker Yard

Clanker Yard es una app para macOS que convierte issues de Linear o de una cola local en pull requests de GitHub. Tú eliges el repo y los agentes; Yard coordina el trabajo y te avisa cuando necesita una decisión. Las corridas siguen aunque cierres la ventana.

## Cómo funciona

1. **Armas un proyecto:** eliges qué issues entran a la cola, en qué repo se trabajan y qué modelo usa cada rol. Puedes combinar Claude Code, Codex y OpenCode.
2. **Yard toma una issue** y la trabaja en una copia aislada del repo (*worktree*). El flujo incluido, **De issue a PR**, planifica, implementa, corre los checks de la [receta del repo](.clanker/recipe.json) y revisa los cambios con cuatro agentes en paralelo.
3. **Recibes un PR para revisar.** Yard arma los commits, abre el PR en draft y sigue la CI y el feedback del bot de review, si lo configuraste. Si el flujo necesita tu criterio, solo esa corrida espera en la Bandeja.

## Qué puedes hacer

- **Trabajar en paralelo:** priorizar issues, respetar sus dependencias y reservar cupos separados para desarrollo y mantenimiento de PRs.
- **Mantener PRs apilados:** ver qué PR depende de cuál, mantener los hijos en local para ahorrar CI y reubicarlos cuando se mergea su base.
- **Pedir cambios desde el PR:** conversar con un agente que prepara un borrador aparte y revisar su propuesta antes de aplicarla.
- **Seguir las corridas:** ver en qué paso están, consultar su costo y responder decisiones desde la Bandeja.
- **Adaptar el equipo:** editar flujos, roles y perfiles, y aprobar notas de los agentes para que se usen en futuras corridas.

## Instalar y empezar

Desde una Mac con Apple Silicon, Git y Node 24:

```bash
git clone https://github.com/SimonOyaneder/clanker-yard.git
cd clanker-yard
npm ci
npm run install:mac
```

Esto abre la app e instala la CLI en `~/.local/bin/clanker`.

1. En **Conexiones**, conecta GitHub para publicar con tu cuenta y agrega el checkout local del repo. Si usarás Linear, conecta también tu workspace.
2. Crea un proyecto (`⌘N`), elige el tracker, el repo y un perfil cuyos agentes tengas configurados. Con el proyecto activo, Yard toma las issues elegibles automáticamente.

## Usar el MCP desde tu asistente

El MCP conecta tu asistente al mismo proceso local que usa la app. Por ejemplo, para registrarlo en Claude Code después de instalar Yard:

```bash
claude mcp add -s user clanker -- ~/.local/bin/clanker mcp
```

En una conversación, prueba: **«Muéstrame la cola del proyecto demo y dime por qué están bloqueadas sus issues»**. Cambia `demo` por el nombre de tu proyecto. El asistente usa `list` con `{"kind":"project"}` para encontrar su ID y `project_queue` con ese ID para leer el estado y el motivo de cada issue.

También puedes pedirle «muéstrame el diff de este PR local» o «solicita publicarlo». La solicitud llega a la **Bandeja**: el MCP no publica ese PR directamente. Si prefieres la terminal, `clanker status` muestra el estado del core y `clanker --help` lista los comandos.

## Desarrollo

Para explorar la interfaz con datos de ejemplo, corre `npm run dev -w packages/ui`. Para trabajar en el código, consulta la [guía del repo](AGENTS.md); el [diseño del MCP](docs/design.html#mcp) describe cómo se exponen las herramientas.
