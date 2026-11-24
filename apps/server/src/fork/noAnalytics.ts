import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AnalyticsService from "../telemetry/AnalyticsService.ts";

/** Fork: product events are dropped where they are recorded, so none reach T3 Code's ingest. */
export const layer = Layer.succeed(
  AnalyticsService.AnalyticsService,
  AnalyticsService.AnalyticsService.of({
    record: Effect.fn("noAnalytics.record")(() => Effect.void),
    flush: Effect.void,
    recordOwners: Effect.fn("noAnalytics.recordOwners")(() => Effect.void),
  }),
);
