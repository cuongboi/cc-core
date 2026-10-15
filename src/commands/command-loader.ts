import { Command } from "commander";
import { DependencyContainer, type ModuleNode } from "../di/container";
import type { Type } from "../di/types";

export interface ProgramOptions {
  name: string;
  description?: string;
  version?: string;
}

/**
 * Build a `commander` program from a root module: resolve the module graph and
 * register every command declared in it, each with dependencies from its own module.
 * Does not parse `argv` — useful for tests and further customisation.
 */
export function createProgram(rootModule: Type, options: ProgramOptions): Command {
  const program = new Command(options.name);
  if (options.description) program.description(options.description);
  if (options.version) program.version(options.version);

  const rootNode = new DependencyContainer().getOrCreateModuleNode(rootModule);
  const visited = new Set<ModuleNode>();

  const registerCommands = (node: ModuleNode) => {
    if (visited.has(node)) return;
    visited.add(node);

    for (const CommandClass of node.metadata.commands ?? []) {
      // Seed the path with the command so resolution errors name it.
      node.instantiateClass(CommandClass, [CommandClass]).register(program);
    }
    for (const imported of node.importedModules) {
      registerCommands(imported);
    }
  };
  registerCommands(rootNode);

  return program;
}

/**
 * Build the program and run it. Resolves once the command (including async `exec`)
 * has finished, and rejects if it throws.
 *
 * @param argv Defaults to `process.argv`.
 */
export function loadCommand(
  rootModule: Type,
  options: ProgramOptions,
  argv?: readonly string[],
): Promise<Command> {
  return createProgram(rootModule, options).parseAsync(argv);
}
