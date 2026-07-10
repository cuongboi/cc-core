import "reflect-metadata";

export function Injectable(): ClassDecorator {
  return (target: object) => {
    // Decorator just to trigger metadata emission or mark the class as injectable
  };
}
