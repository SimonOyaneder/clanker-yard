import { BadRequestError } from "../errors/domain";
import type { Artifact } from "./artifacts";

const continuation = (byte: number | undefined): boolean => byte !== undefined && (byte & 0xc0) === 0x80;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Devuelve texto alineado a un carácter UTF-8, etiquetado con el offset de la próxima página. */
export function artifactTextPage({ content, ...meta }: Artifact, offset: number, limit: number) {
  if (!/^(?:text\/|application\/(?:json|[^;/]+\+json)(?:;|$))/i.test(meta.mime)) {
    throw new BadRequestError("El artefacto no es de texto.");
  }
  if (offset > content.length || continuation(content[offset])) {
    throw new BadRequestError("El offset no está al inicio de un carácter del artefacto: usa nextOffset.");
  }
  let end = Math.min(offset + limit, content.length);
  while (continuation(content[end])) end -= 1;
  let text: string;
  try {
    text = decoder.decode(content.subarray(offset, end));
  } catch {
    throw new BadRequestError("El artefacto no se puede leer como texto UTF-8.");
  }
  return { ...meta, text, nextOffset: end === content.length ? null : end };
}
