import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname } from "node:path";

/**
 * Sirve un remoto bare por HTTP con `git http-backend` detrás de Basic auth: el origin con el que push y
 * fetch pasan por credenciales, como contra GitHub. `url` es la URL del repo; `authorizations` anota con
 * qué credenciales llegó cada request (`password` puede ser una función, para un token que rota). Para
 * aceptar pushes el bare necesita `http.receivepack=true`.
 */
export async function startGitHttpServer(
  bareDir: string,
  credentials: { user: string; password: string | (() => string) },
): Promise<{ url: string; authorizations: string[]; close(): Promise<void> }> {
  const authorizations: string[] = [];
  const password = () => (typeof credentials.password === "function" ? credentials.password() : credentials.password);
  const server: Server = createServer((req, res) => {
    const authorization = req.headers.authorization;
    if (authorization !== undefined) authorizations.push(authorization);
    if (authorization !== `Basic ${Buffer.from(`${credentials.user}:${password()}`).toString("base64")}`) {
      req.resume();
      res.writeHead(401, { "www-authenticate": 'Basic realm="fake"' }).end("unauthorized");
      return;
    }
    const url = new URL(req.url ?? "/", "http://fake");
    const cgi = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_PROJECT_ROOT: dirname(bareDir),
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: req.method,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers["content-type"],
        CONTENT_LENGTH: req.headers["content-length"],
        HTTP_CONTENT_ENCODING: req.headers["content-encoding"],
        REMOTE_USER: credentials.user,
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    req.pipe(cgi.stdin);
    const chunks: Buffer[] = [];
    cgi.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    cgi.on("close", () => {
      const out = Buffer.concat(chunks);
      const split = out.indexOf("\r\n\r\n");
      const head = out.subarray(0, split).toString("utf8").split("\r\n");
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head) {
        const [name, ...value] = line.split(": ");
        if (name!.toLowerCase() === "status") status = Number.parseInt(value.join(": "), 10);
        else headers[name!] = value.join(": ");
      }
      res.writeHead(status, headers).end(out.subarray(split + 4));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/${basename(bareDir)}`,
    authorizations,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
