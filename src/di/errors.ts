import type { InjectionToken } from "./types";

/** Human-readable name for a token. Safe for symbols, which throw in template literals. */
export function tokenName(token: unknown): string {
  if (typeof token === "function") return token.name || "<anonymous class>";
  if (typeof token === "symbol") return token.toString();
  return String(token);
}

const formatPath = (path: readonly InjectionToken[]) => path.map(tokenName).join(" -> ");

/** Base class for every error thrown by the DI container. */
export class ResolutionError extends Error {
  override name = "ResolutionError";
}

export class ProviderNotFoundError extends ResolutionError {
  override name = "ProviderNotFoundError";

  constructor(
    readonly token: InjectionToken,
    readonly moduleClass: Function,
    path: readonly InjectionToken[] = [],
  ) {
    const via = path.length ? ` (while resolving ${formatPath(path)})` : "";
    super(
      `Provider not found: ${tokenName(token)} in module ${tokenName(moduleClass)}${via}. ` +
        `Register it in "providers", or import a module that exports it.`,
    );
  }
}

export class CircularDependencyError extends ResolutionError {
  override name = "CircularDependencyError";

  constructor(readonly path: readonly InjectionToken[]) {
    super(`Circular dependency detected: ${formatPath(path)}`);
  }
}

export class InvalidProviderError extends ResolutionError {
  override name = "InvalidProviderError";

  constructor(
    readonly provider: unknown,
    readonly moduleClass: Function,
  ) {
    super(
      `Invalid provider in module ${tokenName(moduleClass)}: expected a class or an object with ` +
        `"provide" and one of "useClass", "useValue" or "useFactory".`,
    );
  }
}
