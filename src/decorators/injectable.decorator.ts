/**
 * Marks a class as managed by the DI container. The decorator itself is a no-op:
 * its presence is what makes TypeScript emit `design:paramtypes` for the constructor,
 * which the container uses to resolve dependencies by type.
 */
export function Injectable(): ClassDecorator {
  return () => {};
}
