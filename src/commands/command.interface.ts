import type { Argument, Command, Option } from "commander";

export interface CommandInterface {
  name: string;
  description?: string;
  options?: Option[];
  arguments?: Argument[];
  register(program: Command): void;
  exec(...args: unknown[]): Promise<void> | void;
}
