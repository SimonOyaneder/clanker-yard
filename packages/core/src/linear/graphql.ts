/** Linear respondió con un error GraphQL, una cuota agotada o un HTTP inesperado. */
export class LinearApiError extends Error {
  override name = "LinearApiError";
  constructor(
    message: string,
    /** `extensions.code` del primer error de Linear (`RATELIMITED`...), si lo trae. */
    readonly code?: string,
  ) {
    super(message);
  }
}

export type LinearGraphql = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

export interface LinearGraphqlOptions {
  endpoint: string;
  /** Se pide en cada request: el access token de Linear se refresca solo cuando le queda poco. */
  token(): Promise<string>;
  fetch?: typeof fetch;
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
}

/** El único punto por donde sale una request al GraphQL de Linear. */
export function createLinearGraphql({ endpoint, token, fetch: doFetch = fetch }: LinearGraphqlOptions): LinearGraphql {
  return async <T>(query: string, variables?: Record<string, unknown>) => {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ query, variables }),
    });
    // Linear responde los errores GraphQL con un 400 y un JSON; los cortes de cuota son un 429.
    const body = (await response.json().catch(() => undefined)) as GraphqlResponse<T> | undefined;

    if (body?.errors?.length) {
      const code = body.errors[0]?.extensions?.code;
      const detail = body.errors.map((e) => e.message).join("; ");
      if (response.status === 429 || code === "RATELIMITED") {
        const wait = response.headers.get("retry-after");
        throw new LinearApiError(`Linear cortó por cuota${wait ? `: reintenta en ${wait} s` : ""} (${detail}).`, "RATELIMITED");
      }
      throw new LinearApiError(`Linear rechazó la operación: ${detail}`, code);
    }
    if (!response.ok || body?.data === undefined) {
      throw new LinearApiError(`Linear respondió HTTP ${response.status} sin datos${response.status === 401 ? ": el token no vale, reconecta Linear" : ""}.`);
    }
    return body.data;
  };
}
