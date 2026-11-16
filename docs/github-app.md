# GitHub App de Clanker Yard

Cómo registrar la GitHub App, instalarla en `SimonOyaneder/clanker-yard` y darle su `client_id` al core. Es la credencial de las fases 2b y 3 (`docs/design.html#integraciones`, `docs/design.html#decisiones`): los agentes actúan **como tú** con un token de usuario (user-to-server) que se consigue con el device flow, sin client secret ni private key en la app.

Registrarla es un paso manual en github.com: nadie la crea por ti. El manifiesto (`docs/github-app-manifest.json`) y esta guía se escribieron contra la documentación de GitHub y no se probaron contra github.com; los puntos dudosos están marcados con **[sin verificar]**.

## Qué se registra

| Ajuste | Valor | Por qué |
| --- | --- | --- |
| Contents | Read and write | Push de las ramas de los PRs. |
| Pull requests | Read and write | Abrir y editar PRs, reviews y threads. |
| Issues | Read and write | Los comentarios de un PR son comentarios de issue. |
| Checks | Read-only | El estado de CI de un PR. |
| Commit statuses | Read-only | Los estados de CI que no son check runs (merge-queue, por ejemplo). |
| Metadata | Read-only | GitHub lo agrega siempre. |
| Device flow | Habilitado | Es como el usuario conecta GitHub desde la app. |
| Webhooks | Inactivos | Sin relay, el core hace polling con ETags. |
| Visibilidad | "Only on this account" | Solo tú la puedes instalar. |

Son los permisos que Clanker Yard necesita de GitHub (`PERMISSIONS` en `github/pat.ts`, lo que valida el token pegado); un test los compara para que no se separen. Un fine-grained PAT no sirve: no tiene el permiso Checks, así que el PAT pegado es un classic con `repo`, y esta App es el camino a largo plazo. Un token de usuario de una GitHub App solo puede lo que la app tiene **y** lo que tú puedes, y solo ve los repos donde la app está instalada.

Fuera a propósito: `workflows` (un push que toque `.github/workflows/` falla; el PAT classic con `repo` tampoco lo tiene) y `statuses` (ver "Si el CI sale vacío").

## 1. Registrarla

Dos caminos que dejan la misma App. El primero ahorra marcar los permisos a mano.

### Con el manifiesto

Desde la raíz del repo, genera una página que envía `docs/github-app-manifest.json` a GitHub (GitHub pide un POST con el campo `manifest`) y ábrela con tu sesión de github.com iniciada:

```sh
d=$(mktemp -d)
python3 - docs/github-app-manifest.json > "$d/app.html" <<'PY'
import html, sys
manifest = open(sys.argv[1]).read()
print(f'<form id="f" method="post" action="https://github.com/settings/apps/new"><input type="hidden" name="manifest" value="{html.escape(manifest)}"></form><script>f.submit()</script>')
PY
open "$d/app.html"
```

GitHub muestra el formulario "Register new GitHub App" ya lleno. Cambia el nombre si "Clanker Yard" está tomado (es único en todo GitHub) y pulsa **Create GitHub App**. GitHub redirige a `http://127.0.0.1:48722/github-app/created?code=...`, donde no escucha nadie: el navegador mostrará un error y no importa, la App ya existe. El `code` solo sirve para canjear las credenciales con `POST /app-manifests/{code}/conversions` y no hace falta, porque el core no usa private key ni client secret.

**[sin verificar]** Que GitHub acepte el manifiesto sin `hook_attributes` (su documentación solo marca como obligatorio el `url` de ese objeto) y sin `callback_urls`. Si lo rechaza o deja el webhook activo, usa el camino manual.

### A mano

Settings, Developer settings, GitHub Apps, **New GitHub App** (https://github.com/settings/apps/new):

- GitHub App name: `Clanker Yard`. Homepage URL: `https://github.com/SimonOyaneder/clanker-yard`.
- Callback URL: vacío. Request user authorization (OAuth) during installation: desmarcado.
- Webhook: desmarca **Active**.
- Permissions, Repository permissions: Checks y Commit statuses Read-only; Contents, Issues y Pull requests Read and write. Ninguno más.
- Where can this GitHub App be installed: **Only on this account**.

## 2. Ajustes que el manifiesto no puede poner

En la App creada (Settings, Developer settings, GitHub Apps, **Edit**), sección "Identifying and authorizing users":

1. Marca **Enable Device Flow**. Viene apagado y el manifiesto no lo expone; sin esto GitHub responde `device_flow_disabled`.
2. Deja marcado **Expire user authorization tokens**. Es lo que da el token de 8 h con refresh de 6 meses que el core espera; si lo apagas, el token no vence y no hay refresh.
3. Copia el **Client ID** (arriba, en "About"; empieza con `Iv`). No es el App ID numérico: el device flow usa el Client ID. No es un secreto.

No generes private key ni client secret: no se usan.

## 3. Instalarla en el repo

1. En la App, **Install App** (barra lateral), la cuenta `SimonOyaneder`, **Install**.
2. Elige **Only select repositories** y marca `clanker-yard`.

Sin instalar, el token de usuario no ve el repo. Para sumar repos después, Settings, Applications, Installed GitHub Apps, **Configure**. Si un repo tiene branch protection o rulesets, la App no tiene bypass propio: el token actúa como tú, así que valen tus permisos.

## 4. Darle el `client_id` al core

El core lee el `client_id` al arrancar, de dos lugares (el entorno gana):

- `<dataDir>/config.json`:

  ```json
  { "githubApp": { "clientId": "Iv23liXXXXXXXXXXXXXX", "slug": "clanker-yard" } }
  ```

  `slug` es opcional (el nombre corto de la App, el de `github.com/apps/<slug>`): con él, si la App no está instalada, la tarjeta de Conexiones ofrece el botón que abre la instalación. Variable `CLANKER_GITHUB_APP_SLUG`.

  El mismo archivo puede sobreescribir el `client_id` de la OAuth app de Linear, que la app ya trae incluido (`"linear": { "clientId": "..." }`, variable `CLANKER_LINEAR_CLIENT_ID`).

  `dataDir` es `~/Library/Application Support/Clanker Yard` en macOS, `~/.local/share/clanker-yard` en Linux y `%APPDATA%\Clanker Yard` en Windows; con `CLANKER_HOME`, esa carpeta. Es el lugar para la app de escritorio, que lanzada desde el Dock no hereda variables de la terminal.
- La variable `CLANKER_GITHUB_APP_CLIENT_ID`, para dev y tests.

Un `config.json` que no es JSON, trae claves desconocidas o un `clientId` vacío hace fallar el arranque con el motivo y la ruta. Reinicia el core para que lo lea. ## 5. Conectar desde la app

En Conexiones, GitHub, **Conectar con la GitHub App**: la app muestra el código en grande (`WDJB-MJHT`) con el tiempo que le queda, lo copia y abre https://github.com/login/device (**Copiar y abrir GitHub** lo repite); escríbelo y aprueba. La cuenta aparece sola, con el chip "GitHub App" (un PAT lleva "Token personal"). Si cancelas en GitHub o el código vence, la tarjeta lo dice enseguida y ofrece intentar de nuevo. Si la App no está instalada, la cuenta conecta pero la tarjeta avisa (el token no ve ningún repo hasta instalarla, paso 3) y tiene **Volver a revisar**. El core renueva el token (8 h) solo; si GitHub rechaza la renovación (revocaste la App o pasaron 6 meses sin uso), la conexión queda en rojo, lo que publica espera y basta con volver a pulsar el botón. Si el core responde que falta el `client_id` o que el device flow está deshabilitado, revisa los pasos 2 y 4. Se puede cambiar de PAT a App (y al revés) sobre la misma cuenta: la última que conectes reemplaza a la anterior.

## Después

- Cuando el flujo funcione de punta a punta en este repo (CLA-102), el equipo de DX de Acme ayuda a registrarla e instalarla en `example-org` (decisión del diseño, fase 3). Allí la registra y instala un owner de la org: usa el mismo manifiesto, cambiando `url` y registrándola desde la org (`https://github.com/organizations/<org>/settings/apps/new`).
- Si cambias los permisos de una App ya instalada, el owner de cada instalación tiene que aceptar el cambio; hasta entonces los tokens siguen con los permisos viejos.

## Si el CI sale vacío

El core lee el CI de un PR por GraphQL (`checks` y commit statuses). Los commit statuses (los que publica `merge-queue`, por ejemplo) requieren el permiso **Commit statuses: Read-only**, que la App y el PAT piden. Si en un repo el CI aparece vacío o sin los estados de merge-queue, revisa que el owner haya aceptado ese permiso. **[sin verificar]** contra un repo real.

## Referencias

- Manifiesto: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
- Device flow y vencimientos: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
- Editar una App: https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration
