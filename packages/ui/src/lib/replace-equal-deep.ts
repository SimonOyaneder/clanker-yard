const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

/**
 * `next`, pero reusando de `prev` todo lo que es igual (arrays y objetos planos, en profundidad): si nada cambió devuelve
 * `prev` tal cual, y si cambió un elemento de una lista, los demás conservan su identidad. Así un refresco del core que
 * trae lo mismo no invalida `useMemo` ni re-renderiza filas memoizadas. Lo que no es array ni objeto plano (un `Map`, una
 * fecha) se compara por identidad.
 */
export function replaceEqualDeep<T>(prev: unknown, next: T): T {
  if (prev === next) return next
  const arrays = Array.isArray(prev) && Array.isArray(next)
  if (!arrays && !(isPlainObject(prev) && isPlainObject(next))) return next

  const prevObj = prev as Record<string, unknown>
  const nextObj = next as Record<string, unknown>
  const prevKeys = arrays ? null : Object.keys(prevObj)
  const nextKeys = arrays ? null : Object.keys(nextObj)
  const prevSize = arrays ? (prev as unknown[]).length : prevKeys!.length
  const size = arrays ? (next as unknown[]).length : nextKeys!.length
  const copy: Record<string, unknown> | unknown[] = arrays ? [] : {}

  let equal = 0
  for (let i = 0; i < size; i++) {
    const key = arrays ? i : nextKeys![i]!
    const value = replaceEqualDeep(prevObj[key], nextObj[key])
    ;(copy as Record<string | number, unknown>)[key] = value
    if (value === prevObj[key] && (arrays || Object.prototype.hasOwnProperty.call(prevObj, key))) equal++
  }
  return (prevSize === size && equal === prevSize ? prev : copy) as T
}
