import { Module } from "../../decorators/module.decorator";
import { ScheduleOrchestrator } from "./schedule.orchestrator";
import { SchedulerRegistry } from "./scheduler.registry";

/**
 * Import once to enable `@Cron()`, `@Interval()` and `@Timeout()` across the whole module graph.
 * Inject {@link ScheduleOrchestrator} into the command that should run the jobs, and
 * {@link SchedulerRegistry} wherever jobs are inspected or added at runtime.
 */
@Module({
  providers: [SchedulerRegistry, ScheduleOrchestrator],
  exports: [SchedulerRegistry, ScheduleOrchestrator],
})
export class ScheduleModule {}
