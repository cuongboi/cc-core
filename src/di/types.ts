/** A class constructor. */
export interface Type<T = any> extends Function {
  new (...args: any[]): T;
}

/** Anything that can identify a provider: a class, a string, or a symbol. */
export type InjectionToken<T = any> = Type<T> | string | symbol;

interface BaseProvider<T> {
  provide: InjectionToken<T>;
  /** Collect every provider registered under `provide` into an array. */
  multi?: boolean;
}

export interface ClassProvider<T = any> extends BaseProvider<T> {
  useClass: Type<T>;
}

export interface ValueProvider<T = any> extends BaseProvider<T> {
  useValue: T;
}

export interface FactoryProvider<T = any> extends BaseProvider<T> {
  useFactory: (...args: any[]) => T;
  inject?: InjectionToken[];
}

export type ProviderDefinition<T = any> = ClassProvider<T> | ValueProvider<T> | FactoryProvider<T>;

/** A class (shorthand for `{ provide: X, useClass: X }`) or a provider definition. */
export type Provider<T = any> = Type<T> | ProviderDefinition<T>;
