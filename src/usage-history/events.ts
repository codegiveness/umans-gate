// UsageEventDetector — stateful tuple diff detector for usage_events (ticket 02).
//
// SRP: this module owns ONLY event detection + persistence. It subscribes to
// UmansUsageClient.onChange() alongside the samples writer, computes the two
// composite tuples defined in decision 04 (priority + service_mode), compares
// each to its last-seen state, and writes an event row via UsageHistoryStore.
// It never touches usage_samples storage.
//
// DIP: depends on the narrow RecordEventAccessor interface (recordEvent +
// getOpenEventForTuple) exposed by UsageHistoryStore, not on the store's
// internals.

import { createLogger } from "../logger.js";
import type { UsageSnapshot } from "../types.js";
import type { EventTransition, TupleKind } from "./store.js";

const log = createLogger("usage-events");

/** Narrow interface the detector depends on (ISP: only the methods it uses). */
export interface RecordEventAccessor {
  recordEvent(input: {
    snap: UsageSnapshot;
    transition: EventTransition;
    tupleKind: TupleKind;
    previousEventId: number | null;
  }): number;
  getOpenEventForTuple(tupleKind: TupleKind): { id: number } | null;
}

/** Priority tuple per decision 04:
 *  {priorityLow, boxedUntil, boxedReason, unitsDemoted, demotedUntil}.
 *  A change in ANY component = a transition. */
interface PriorityTuple {
  priorityLow: boolean;
  boxedUntil: number | null;
  boxedReason: string | null;
  unitsDemoted: boolean;
  demotedUntil: number | null;
}

/** Service_mode tuple per decision 04: {current, resetsAt}.
 *  A change in either field = a transition. */
interface ServiceModeTuple {
  current: string;
  resetsAt: number | null;
}

function priorityTupleOf(s: UsageSnapshot): PriorityTuple {
  return {
    priorityLow: s.priorityLow,
    boxedUntil: s.boxedUntil,
    boxedReason: s.boxedReason,
    unitsDemoted: s.unitsDemoted,
    demotedUntil: s.demotedUntil,
  };
}

function serviceModeTupleOf(s: UsageSnapshot): ServiceModeTuple {
  return {
    current: s.serviceMode.current,
    resetsAt: s.serviceMode.resetsAt,
  };
}

function isDefaultPriority(t: PriorityTuple): boolean {
  return (
    !t.priorityLow &&
    t.boxedUntil === null &&
    t.boxedReason === null &&
    !t.unitsDemoted &&
    t.demotedUntil === null
  );
}

function isDefaultServiceMode(t: ServiceModeTuple): boolean {
  return t.current === "normal" && t.resetsAt === null;
}

function samePriority(a: PriorityTuple, b: PriorityTuple): boolean {
  return (
    a.priorityLow === b.priorityLow &&
    a.boxedUntil === b.boxedUntil &&
    a.boxedReason === b.boxedReason &&
    a.unitsDemoted === b.unitsDemoted &&
    a.demotedUntil === b.demotedUntil
  );
}

function sameServiceMode(a: ServiceModeTuple, b: ServiceModeTuple): boolean {
  return a.current === b.current && a.resetsAt === b.resetsAt;
}

/** Result of a single handleSnapshot pass: which tuples transitioned and how.
 *  Empty when nothing fired. The caller uses this to broadcast WS dirty
 *  notifications (ticket 07). */
export interface DetectorEmissions {
  priority?: EventTransition;
  service_mode?: EventTransition;
}

export class UsageEventDetector {
  private readonly store: RecordEventAccessor;
  private lastPriority: PriorityTuple | null = null;
  private lastServiceMode: ServiceModeTuple | null = null;

  constructor(store: RecordEventAccessor) {
    this.store = store;
  }

  /** Subscribe hook — call on every UmansUsageClient onChange fire.
   *  Returns the transitions that fired this pass (empty when none). */
  handleSnapshot(snap: UsageSnapshot): DetectorEmissions {
    // Failed snapshots: skip (same rule as samples writer).
    if (!snap.ok) return {};

    const currentPriority = priorityTupleOf(snap);
    const currentServiceMode = serviceModeTupleOf(snap);

    // First-ever snapshot: seed state silently, emit no event.
    if (this.lastPriority === null || this.lastServiceMode === null) {
      this.lastPriority = currentPriority;
      this.lastServiceMode = currentServiceMode;
      return {};
    }
    const prevPriority = this.lastPriority;
    const prevServiceMode = this.lastServiceMode;

    const emissions: DetectorEmissions = {};

    if (!samePriority(currentPriority, prevPriority)) {
      emissions.priority = this.emitPriorityEvent(snap, currentPriority, prevPriority);
      this.lastPriority = currentPriority;
    }

    if (!sameServiceMode(currentServiceMode, prevServiceMode)) {
      emissions.service_mode = this.emitServiceModeEvent(snap, currentServiceMode, prevServiceMode);
      this.lastServiceMode = currentServiceMode;
    }

    return emissions;
  }

  private emitPriorityEvent(
    snap: UsageSnapshot,
    current: PriorityTuple,
    prev: PriorityTuple,
  ): EventTransition {
    const prevDefault = isDefaultPriority(prev);
    const currentDefault = isDefaultPriority(current);
    let transition: EventTransition;
    if (prevDefault && !currentDefault) {
      transition = "onset";
    } else if (!prevDefault && currentDefault) {
      transition = "resolved";
    } else {
      // !prevDefault && !currentDefault — degraded → different degraded
      transition = "morph";
    }
    const previousEventId =
      transition === "onset" ? null : (this.store.getOpenEventForTuple("priority")?.id ?? null);
    this.store.recordEvent({
      snap,
      transition,
      tupleKind: "priority",
      previousEventId,
    });
    log.info(`priority ${transition} at ${snap.fetchedAt}`);
    return transition;
  }

  private emitServiceModeEvent(
    snap: UsageSnapshot,
    current: ServiceModeTuple,
    prev: ServiceModeTuple,
  ): EventTransition {
    const prevDefault = isDefaultServiceMode(prev);
    const currentDefault = isDefaultServiceMode(current);
    let transition: EventTransition;
    if (prevDefault && !currentDefault) {
      transition = "onset";
    } else if (!prevDefault && currentDefault) {
      transition = "resolved";
    } else {
      transition = "morph";
    }
    const previousEventId =
      transition === "onset" ? null : (this.store.getOpenEventForTuple("service_mode")?.id ?? null);
    this.store.recordEvent({
      snap,
      transition,
      tupleKind: "service_mode",
      previousEventId,
    });
    log.info(`service_mode ${transition} at ${snap.fetchedAt}`);
    return transition;
  }
}
