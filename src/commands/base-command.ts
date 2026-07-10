import { type Argument, Command, type Option } from "commander";
import type { CommandInterface } from "./command.interface";

export abstract class BaseCommand implements CommandInterface {
  abstract name: string;
  description?: string;
  arguments?: Argument[];
  options?: Option[];

  register(program: Command) {
    const command = program.command(this.name);
    if (this.description) {
      command.description(this.description);
    }

    if (this.options) {
      for (const option of this.options) {
        command.addOption(option);
      }
    }

    if (this.arguments) {
      for (const argument of this.arguments) {
        command.addArgument(argument);
      }
    }

    command.action(this.exec.bind(this));
  }

  abstract exec(...args: unknown[]): Promise<any> | any;
}
