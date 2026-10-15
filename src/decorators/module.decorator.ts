import "reflect-metadata";
import type { CommandInterface } from "../commands/command.interface";
import type { InjectionToken, Provider, Type } from "../di/types";

export const MODULE_METADATA = Symbol("MODULE_METADATA");

export interface ModuleOptions {
  /** Modules whose exported providers become available in this module. */
  imports?: Type[];
  /** Providers owned by this module. */
  providers?: Provider[];
  /** Tokens of this module's providers that importing modules may resolve. */
  exports?: InjectionToken[];
  /** Command classes registered on the CLI program. */
  commands?: Type<CommandInterface>[];
}

export function Module(options: ModuleOptions): ClassDecorator {
  return (target: object) => {
    Reflect.defineMetadata(MODULE_METADATA, options, target);
  };
}
