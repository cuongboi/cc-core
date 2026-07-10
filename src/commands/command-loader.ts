import { Command } from "commander";
import { DependencyContainer, type ModuleNode } from "../di/container";

export function loadCommand(
  rootModuleClass: any,
  option: {
    name: string;
    description: string;
    version: string;
  },
) {
  const program = new Command(option.name).description(option.description).version(option.version);

  const container = new DependencyContainer();
  const rootNode = container.getOrCreateModuleNode(rootModuleClass);

  const seenModules = new Set<any>();

  function registerCommands(node: ModuleNode) {
    if (seenModules.has(node.moduleClass)) {
      return;
    }
    seenModules.add(node.moduleClass);

    const commands = node.metadata.commands || [];
    for (const CommandClass of commands) {
      const commandInstance = node.instantiateClass(CommandClass, []);
      commandInstance.register(program);
    }

    for (const importedNode of node.importedModules) {
      registerCommands(importedNode);
    }
  }

  registerCommands(rootNode);

  program.parse();
}
