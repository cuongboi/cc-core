import "reflect-metadata";
import {
  INJECT_METADATA,
  INJECT_PROPERTIES_METADATA,
  type InjectionMetadata,
} from "../decorators/inject.decorator";
import { MODULE_METADATA, type ModuleOptions } from "../decorators/module.decorator";
import {
  CircularDependencyError,
  InvalidProviderError,
  ProviderNotFoundError,
  ResolutionError,
  tokenName,
} from "./errors";
import type { InjectionToken, ProviderDefinition, Type } from "./types";

const PARAMTYPES_METADATA = "design:paramtypes";

/** Types emitted for primitives, interfaces and unions — never valid as tokens on their own. */
const NON_INJECTABLE_TYPES = new Set<unknown>([Object, String, Number, Boolean, Symbol, Array, Function, Promise]);

/** Owns one `ModuleNode` per module class; module graphs may share and cycle. */
export class DependencyContainer {
  private readonly moduleNodes = new Map<Type, ModuleNode>();

  getOrCreateModuleNode(moduleClass: Type): ModuleNode {
    const existing = this.moduleNodes.get(moduleClass);
    if (existing) return existing;

    const metadata: ModuleOptions | undefined = Reflect.getMetadata(MODULE_METADATA, moduleClass);
    if (!metadata) {
      throw new ResolutionError(
        `${tokenName(moduleClass)} is not a module. Did you forget the @Module() decorator?`,
      );
    }

    // Register before walking imports so circular module imports terminate.
    const node = new ModuleNode(moduleClass, metadata);
    this.moduleNodes.set(moduleClass, node);

    for (const imported of metadata.imports ?? []) {
      node.importedModules.push(this.getOrCreateModuleNode(imported));
    }

    return node;
  }
}

interface ProviderEntry {
  /** Resolve to an array of every definition rather than a single value. */
  multi: boolean;
  definitions: ProviderDefinition[];
}

/**
 * The providers, exports and cached instances of a single module.
 * Providers are created lazily and cached, so each token is a singleton per module.
 */
export class ModuleNode {
  readonly importedModules: ModuleNode[] = [];
  readonly instances = new Map<InjectionToken, unknown>();
  private readonly providers = new Map<InjectionToken, ProviderEntry>();

  constructor(
    readonly moduleClass: Type,
    readonly metadata: ModuleOptions,
  ) {
    for (const provider of metadata.providers ?? []) {
      this.register(provider);
    }
  }

  /**
   * Registering the same token more than once (or with `multi: true`) turns it into
   * a multi-provider that resolves to an array, in registration order.
   */
  private register(provider: unknown): void {
    const definition = normalizeProvider(provider);
    if (!definition) throw new InvalidProviderError(provider, this.moduleClass);

    const entry = this.providers.get(definition.provide);
    if (entry) {
      entry.definitions.push(definition);
      entry.multi = true;
    } else {
      this.providers.set(definition.provide, {
        multi: definition.multi === true,
        definitions: [definition],
      });
    }
  }

  exportsToken(token: InjectionToken): boolean {
    return this.metadata.exports?.includes(token) ?? false;
  }

  resolve<T = any>(token: InjectionToken<T>, path: InjectionToken[] = []): T {
    if (this.instances.has(token)) {
      return this.instances.get(token) as T;
    }

    const entry = this.providers.get(token);
    if (entry) {
      if (path.includes(token)) {
        throw new CircularDependencyError([...path, token]);
      }

      path.push(token);
      let value: unknown;
      try {
        const values = entry.definitions.map((definition) => this.instantiateProvider(definition, path));
        value = entry.multi ? values : values[0];
      } finally {
        path.pop();
      }

      this.instances.set(token, value);
      return value as T;
    }

    for (const imported of this.importedModules) {
      if (imported.exportsToken(token)) {
        return imported.resolve(token, path);
      }
    }

    throw new ProviderNotFoundError(token, this.moduleClass, path);
  }

  /**
   * Construct `cls` with its dependencies resolved from this module, without caching it.
   * Used for commands, which are not providers.
   */
  instantiateClass<T>(cls: Type<T>, path: InjectionToken[] = []): T {
    const { paramTypes, paramInjections } = getConstructorMetadata(cls);

    // Function.length excludes parameters with default values, so this only fires when
    // required parameters exist but no type metadata was emitted for them.
    if (cls.length > paramTypes.length) {
      throw new ResolutionError(
        `Cannot resolve dependencies of ${tokenName(cls)}: no constructor type metadata found. ` +
          `Decorate the class with @Injectable() and enable "emitDecoratorMetadata", ` +
          `or use @Inject(token) on each parameter.`,
      );
    }

    const args = paramTypes.map((paramType, index) => {
      const token = paramInjections.get(index) ?? paramType;
      if (!token || (NON_INJECTABLE_TYPES.has(token) && !paramInjections.has(index))) {
        throw new ResolutionError(
          `Cannot resolve parameter #${index} of ${tokenName(cls)}: ` +
            (token
              ? `type "${tokenName(token)}" is not injectable.`
              : `its type is undefined (often a circular import).`) +
            ` Use @Inject(token) to specify a provider token.`,
        );
      }
      return this.resolve(token, path);
    });

    const instance = new cls(...args);

    for (const [property, token] of getPropertyInjections(cls)) {
      (instance as Record<string | symbol, unknown>)[property] = this.resolve(token, path);
    }

    return instance;
  }

  private instantiateProvider(definition: ProviderDefinition, path: InjectionToken[]): unknown {
    if ("useValue" in definition) {
      return definition.useValue;
    }
    if ("useFactory" in definition) {
      const args = (definition.inject ?? []).map((token) => this.resolve(token, path));
      return definition.useFactory(...args);
    }
    return this.instantiateClass(definition.useClass, path);
  }
}

function normalizeProvider(provider: unknown): ProviderDefinition | undefined {
  if (typeof provider === "function") {
    return { provide: provider as Type, useClass: provider as Type };
  }
  if (
    provider !== null &&
    typeof provider === "object" &&
    "provide" in provider &&
    ("useClass" in provider || "useValue" in provider || "useFactory" in provider)
  ) {
    return provider as ProviderDefinition;
  }
  return undefined;
}

/**
 * Constructor metadata lives on the class that declares the constructor, so walk up the
 * prototype chain to find it. This lets subclasses without their own constructor inherit
 * both the parameter types and the @Inject overrides of their parent.
 */
function getConstructorMetadata(cls: Type) {
  let owner: Function | null = cls;
  while (owner && owner !== Function.prototype) {
    if (Reflect.hasOwnMetadata(PARAMTYPES_METADATA, owner)) break;
    owner = Object.getPrototypeOf(owner);
  }
  if (!owner || owner === Function.prototype) owner = cls;

  const paramTypes: (InjectionToken | undefined)[] =
    Reflect.getOwnMetadata(PARAMTYPES_METADATA, owner) ?? [];
  const injections: InjectionMetadata[] = Reflect.getOwnMetadata(INJECT_METADATA, owner) ?? [];
  const paramInjections = new Map(injections.map(({ index, token }) => [index, token]));

  // A parameter decorated with @Inject but lacking type metadata still counts.
  const arity = Math.max(paramTypes.length, ...injections.map(({ index }) => index + 1));
  return { paramTypes: Array.from({ length: arity }, (_, i) => paramTypes[i]), paramInjections };
}

/** Property injections from the whole prototype chain; subclasses override parents. */
function getPropertyInjections(cls: Type): [string | symbol, InjectionToken][] {
  const merged: Record<string | symbol, InjectionToken> = {};
  const chain: object[] = [];
  for (let proto = cls.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    chain.unshift(proto);
  }
  for (const proto of chain) {
    Object.assign(merged, Reflect.getOwnMetadata(INJECT_PROPERTIES_METADATA, proto));
  }
  return Reflect.ownKeys(merged).map((key) => [key, merged[key]!]);
}
