import "reflect-metadata";
import type { InjectionToken } from "../di/types";

/** Metadata key for constructor-parameter injections (stored on the class). */
export const INJECT_METADATA = Symbol("INJECT_METADATA");
/** Metadata key for property injections (stored on the class prototype). */
export const INJECT_PROPERTIES_METADATA = Symbol("INJECT_PROPERTIES_METADATA");

export interface InjectionMetadata {
  index: number;
  token: InjectionToken;
}

/**
 * Inject `token` into a constructor parameter or a class property.
 * Required for string/symbol tokens, interfaces, and toolchains that don't emit
 * `design:paramtypes` (e.g. esbuild/tsx).
 */
export function Inject(token: InjectionToken): ParameterDecorator & PropertyDecorator {
  return (target: object, propertyKey: string | symbol | undefined, parameterIndex?: number) => {
    if (typeof parameterIndex === "number") {
      const params: InjectionMetadata[] = Reflect.getOwnMetadata(INJECT_METADATA, target) ?? [];
      Reflect.defineMetadata(
        INJECT_METADATA,
        [...params, { index: parameterIndex, token }],
        target,
      );
    } else if (propertyKey !== undefined) {
      const props: Record<string | symbol, InjectionToken> =
        Reflect.getOwnMetadata(INJECT_PROPERTIES_METADATA, target) ?? {};
      Reflect.defineMetadata(
        INJECT_PROPERTIES_METADATA,
        { ...props, [propertyKey]: token },
        target,
      );
    }
  };
}
