import type { Argument, Command, Option } from "commander";
import type { CommandInterface } from "./command.interface";

export abstract class BaseCommand implements CommandInterface {
  abstract name: string;
  description?: string;
  arguments?: Argument[];
  options?: Option[];

  /** Add this command to `program` and return the created sub-command. */
  register(program: Command): Command {
    const command = program.command(this.name);

    if (this.description) command.description(this.description);
    for (const option of this.options ?? []) command.addOption(option);
    for (const argument of this.arguments ?? []) command.addArgument(argument);

    this.configure(command);
    // Pass the result through untouched: a returned promise is awaited by parseAsync(),
    // while sync handlers keep throwing synchronously.
    command.action((...args: unknown[]) => this.exec(...args) as void | Promise<void>);
    return command;
  }

  /**
   * Hook for anything the declarative fields don't cover (aliases, help text, hooks…).
   * Called after options and arguments are added.
   */
  protected configure(_command: Command): void {}

  /** Receives the positional arguments, then the parsed options, then the `Command`. */
  abstract exec(...args: any[]): unknown;
}
