// Public API for the usage-history module.

export {
  addDays,
  computeDailyRow,
  type DayCompleteness,
  type DownsampleDayInput,
  type DownsampleOptions,
  dayUtcOf,
  downsampleDay,
  downsampleRange,
  msUntilNextUtcMidnight,
  pruneOldSamples,
  utcMidnightMs,
} from "./daily.js";
export { type DetectorEmissions, type RecordEventAccessor, UsageEventDetector } from "./events.js";
export {
  migrateUsageHistorySchema,
  USAGE_DAILY_DDL,
  USAGE_EVENTS_DDL,
  USAGE_SAMPLES_DDL,
} from "./schema.js";
export {
  deriveCacheHitRate,
  type EventTransition,
  type RecordEventInput,
  type TupleKind,
  type UsageDailyRow,
  type UsageEventRow,
  UsageHistoryStore,
  type UsageHistoryStoreOptions,
  type UsageSampleRow,
} from "./store.js";
