// Public API for the usage-history module.
export {
  migrateUsageHistorySchema,
  USAGE_DAILY_DDL,
  USAGE_EVENTS_DDL,
  USAGE_SAMPLES_DDL,
} from "./schema.js";
export { UsageEventDetector, type DetectorEmissions, type RecordEventAccessor } from "./events.js";
export {
  type DayCompleteness,
  computeDailyRow,
  downsampleDay,
  downsampleRange,
  dayUtcOf,
  utcMidnightMs,
  addDays,
  msUntilNextUtcMidnight,
  pruneOldSamples,
  type DownsampleDayInput,
  type DownsampleOptions,
} from "./daily.js";
export {
  deriveCacheHitRate,
  type EventTransition,
  type RecordEventInput,
  type TupleKind,
  UsageHistoryStore,
  type UsageDailyRow,
  type UsageEventRow,
  type UsageHistoryStoreOptions,
  type UsageSampleRow,
} from "./store.js";
