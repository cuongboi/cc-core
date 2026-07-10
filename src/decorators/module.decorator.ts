import "reflect-metadata";

export const MODULE_METADATA = Symbol("MODULE_METADATA");

export interface ModuleOptions {
  imports?: any[];
  providers?: any[];
  exports?: any[];
  commands?: any[];
}

export function Module(options: ModuleOptions): ClassDecorator {
  return (target: object) => {
    Reflect.defineMetadata(MODULE_METADATA, options, target);
  };
}
