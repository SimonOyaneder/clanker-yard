import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** El texto de un error para un toast o un aviso: su `message` si es un `Error`, si no lo que sea como texto. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
