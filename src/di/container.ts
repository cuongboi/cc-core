import { MODULE_METADATA } from "../decorators/module.decorator";
import type { ModuleOptions } from "../decorators/module.decorator";
import { INJECT_METADATA as DECORATOR_INJECT_METADATA } from "../decorators/inject.decorator";
import type { InjectionMetadata } from "../decorators/inject.decorator";

export class DependencyContainer {
  private moduleNodes = new Map<any, ModuleNode>();

  getOrCreateModuleNode(moduleClass: any): ModuleNode {
    if (this.moduleNodes.has(moduleClass)) {
      return this.moduleNodes.get(moduleClass)!;
    }

    const metadata: ModuleOptions = Reflect.getMetadata(MODULE_METADATA, moduleClass) || {};
    const node = new ModuleNode(moduleClass, metadata, this);
    this.moduleNodes.set(moduleClass, node);

    if (metadata.imports) {
      for (const importedModule of metadata.imports) {
        node.importedModules.push(this.getOrCreateModuleNode(importedModule));
      }
    }

    return node;
  }
}

export class ModuleNode {
  importedModules: ModuleNode[] = [];
  instances = new Map<any, any>();
  private providersMap = new Map<any, any>();
  private multiProvidersMap = new Map<any, any[]>();

  constructor(
    public moduleClass: any,
    public metadata: ModuleOptions,
    private container: DependencyContainer,
  ) {
    this.registerProviders(metadata.providers || []);
  }

  private registerProviders(providers: any[]) {
    for (const provider of providers) {
      if (typeof provider === "function") {
        this.providersMap.set(provider, { provide: provider, useClass: provider });
      } else if (provider && typeof provider === "object" && "provide" in provider) {
        if (provider.multi === true) {
          // Multi-provider: accumulate under the same token
          const existing = this.multiProvidersMap.get(provider.provide) || [];
          existing.push(provider);
          this.multiProvidersMap.set(provider.provide, existing);
        } else if (this.multiProvidersMap.has(provider.provide)) {
          // If any prior registration for this token was multi, keep it multi
          const existing = this.multiProvidersMap.get(provider.provide)!;
          existing.push(provider);
        } else if (this.providersMap.has(provider.provide)) {
          // Multiple registrations with the same token — auto-promote to multi
          const first = this.providersMap.get(provider.provide)!;
          this.multiProvidersMap.set(provider.provide, [first, provider]);
          this.providersMap.delete(provider.provide);
        } else {
          this.providersMap.set(provider.provide, provider);
        }
      }
    }
  }

  exportsToken(token: any): boolean {
    const exports = this.metadata.exports || [];
    return exports.includes(token);
  }

  resolve(token: any, resolvingStack: any[] = []): any {
    if (resolvingStack.includes(token)) {
      throw new Error(`Circular dependency detected: ${resolvingStack.join(" -> ")} -> ${token}`);
    }

    if (this.instances.has(token)) {
      return this.instances.get(token);
    }

    // Multi-provider: resolve all entries and return as an array
    if (this.multiProvidersMap.has(token)) {
      resolvingStack.push(token);
      const instances = this.multiProvidersMap.get(token)!.map((providerDef) =>
        this.instantiateProvider(providerDef, resolvingStack),
      );
      resolvingStack.pop();
      this.instances.set(token, instances);
      return instances;
    }

    const providerDef = this.providersMap.get(token);
    if (providerDef) {
      resolvingStack.push(token);
      const instance = this.instantiateProvider(providerDef, resolvingStack);
      resolvingStack.pop();
      this.instances.set(token, instance);
      return instance;
    }

    for (const importedNode of this.importedModules) {
      if (importedNode.exportsToken(token)) {
        return importedNode.resolve(token, resolvingStack);
      }
    }

    throw new Error(
      `Provider not found: ${token.name || token} in module ${this.moduleClass.name}`,
    );
  }

  private instantiateProvider(providerDef: any, resolvingStack: any[]): any {
    if ("useValue" in providerDef) {
      return providerDef.useValue;
    }

    if ("useFactory" in providerDef) {
      const injectTokens = providerDef.inject || [];
      const args = injectTokens.map((t: any) => this.resolve(t, resolvingStack));
      return providerDef.useFactory(...args);
    }

    if ("useClass" in providerDef) {
      return this.instantiateClass(providerDef.useClass, resolvingStack);
    }

    throw new Error(`Invalid provider definition for token ${providerDef.provide}`);
  }

  instantiateClass(clazz: any, resolvingStack: any[]): any {
    const paramTypes: any[] = Reflect.getMetadata("design:paramtypes", clazz) || [];
    // Either MODULE_METADATA key or DECORATOR_INJECT_METADATA key could hold metadata
    const paramInjections: InjectionMetadata[] =
      Reflect.getOwnMetadata(DECORATOR_INJECT_METADATA, clazz) || [];

    const args: any[] = [];
    for (let i = 0; i < paramTypes.length; i++) {
      const override = paramInjections.find((p) => p.index === i);
      const token = override ? override.token : paramTypes[i];
      if (!token) {
        throw new Error(
          `Cannot resolve parameter at index ${i} for class ${clazz.name}. Make sure to use @Inject or enable emitDecoratorMetadata.`,
        );
      }
      args.push(this.resolve(token, resolvingStack));
    }

    const instance = new clazz(...args);

    const propertyInjections: Record<string | symbol, any> =
      Reflect.getOwnMetadata(DECORATOR_INJECT_METADATA, clazz.prototype) || {};
    for (const [propKey, token] of Object.entries(propertyInjections)) {
      instance[propKey] = this.resolve(token, resolvingStack);
    }

    return instance;
  }
}
