import "reflect-metadata";

export const INJECT_METADATA = Symbol("INJECT_METADATA");

export interface InjectionMetadata {
  index: number;
  token: any;
}

export function Inject(token: any): ParameterDecorator & PropertyDecorator {
  return (target: object, propertyKey: string | symbol | undefined, parameterIndex?: number) => {
    if (typeof parameterIndex === "number") {
      // Constructor injection (parameter decorator)
      const existing: InjectionMetadata[] = Reflect.getOwnMetadata(INJECT_METADATA, target) || [];
      existing.push({ index: parameterIndex, token });
      Reflect.defineMetadata(INJECT_METADATA, existing, target);
    } else if (propertyKey) {
      // Property injection (property decorator)
      const existingProps: Record<string | symbol, any> =
        Reflect.getOwnMetadata(INJECT_METADATA, target) || {};
      existingProps[propertyKey] = token;
      Reflect.defineMetadata(INJECT_METADATA, existingProps, target);
    }
  };
}
