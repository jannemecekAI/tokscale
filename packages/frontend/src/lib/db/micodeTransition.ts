import type { ClientBreakdownData } from "./helpers";
import { foldParserClientSnapshot, modelsForHighWater, type IncomingParserContribution } from "./parserHighWater";
import { ownValue } from "../safeRecord";

/** Wire contract shared with MICODE_SUBMISSION_PARSER_VERSION in the Rust CLI. */
export const MICODE_SUBMISSION_PARSER_VERSION = 2;
export const MICODE_FAMILY = ["micode", "micode-desktop"] as const;

const COVERAGE_FIELDS = [
  "tokens", "input", "output", "cacheRead", "cacheWrite", "reasoning", "messages",
] as const;
type Coverage = Record<(typeof COVERAGE_FIELDS)[number], number>;
type StoredDay = { date: string; sourceBreakdown: unknown };
type FamilyLayouts = Record<(typeof MICODE_FAMILY)[number], Record<string, ClientBreakdownData>>;

export interface MiCodeTransitionPlan {
  mode: "status-quo" | "freeze" | "replace";
  /** Sticky even for a partial first attempt: an older CLI must not roll back. */
  parserVersions?: Record<string, number>;
  layouts?: FamilyLayouts;
  warning?: string;
}

function addCoverage(target: Coverage, source: Partial<Coverage>): void {
  for (const field of COVERAGE_FIELDS) target[field] += source[field] ?? 0;
}

function emptyCoverage(): Coverage {
  return { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, messages: 0 };
}

function familyCoverage(cells: Array<ClientBreakdownData | undefined>) {
  const total = emptyCoverage();
  const models = new Map<string, Coverage>();
  for (const cell of cells) {
    if (!cell) continue;
    addCoverage(total, cell);
    // Share the credited-ledger normalization: legacy singleton modelId and
    // scalar bucket/message remainders must not disappear from model coverage.
    // An unattributed remainder stays "unknown", never a guessed new model.
    for (const [id, model] of Object.entries(modelsForHighWater(cell))) {
      const count = models.get(id) ?? emptyCoverage();
      addCoverage(count, model);
      models.set(id, count);
    }
  }
  return { total, models };
}

function covers(previous: Coverage, incoming?: Coverage): boolean {
  return COVERAGE_FIELDS.every((field) => {
    const before = previous[field];
    const after = incoming?.[field] ?? 0;
    return Number.isSafeInteger(before) && Number.isSafeInteger(after)
      && before >= 0 && after >= before;
  });
}

/**
 * MiMo changed one accounting identity into two presentation surfaces. Never
 * merge those identities independently: the old micode row already includes
 * desktop spend. Unlike a lifetime max, a covered full snapshot can restore
 * real surface attribution without treating a missing cell as new usage.
 *
 * This intentionally defers ALL family changes for partial/aged/truncated
 * history, even genuine growth: aggregate growth cannot prove where lost
 * history belongs. No retention hint or reported combined total waives that.
 * The device's stored day/model buckets remain the credited baseline; only a
 * generation marker is persisted, in the existing parserVersions JSON.
 */
export function planMiCodeTransition(args: {
  submittedClients: ReadonlySet<string>;
  incomingVersions?: Record<string, number>;
  persistedVersions?: Record<string, number>;
  fullHistory: boolean;
  isBackfill: boolean;
  contributions: Array<IncomingParserContribution & { totals?: { costIsComplete?: boolean } }>;
  existingDays: StoredDay[];
}): MiCodeTransitionPlan {
  const touchesFamily = MICODE_FAMILY.some((client) =>
    args.submittedClients.has(client) || ownValue(args.incomingVersions, client) !== undefined
  );
  if (!touchesFamily) return { mode: "status-quo" };

  const existingBreakdowns = args.existingDays.map((day) => ({
    date: day.date,
    breakdown: (day.sourceBreakdown ?? {}) as Record<string, ClientBreakdownData>,
  }));
  const transitionRequired =
    args.submittedClients.has("micode-desktop") ||
    ownValue(args.incomingVersions, "micode-desktop") !== undefined ||
    existingBreakdowns.some(({ breakdown }) => ownValue(breakdown, "micode-desktop") !== undefined) ||
    MICODE_FAMILY.some((client) =>
      (ownValue(args.incomingVersions, client) ?? 0) >= MICODE_SUBMISSION_PARSER_VERSION ||
      ownValue(args.persistedVersions, client) !== undefined
    );
  // A pre-split CLI can keep submitting to its original, single identity until
  // any split/transition evidence exists for this device.
  if (!transitionRequired) return { mode: "status-quo" };

  const unknownStoredGeneration = MICODE_FAMILY.some((client) =>
    (ownValue(args.persistedVersions, client) ?? 0) > MICODE_SUBMISSION_PARSER_VERSION
  );
  const parserVersions = unknownStoredGeneration ? undefined : Object.fromEntries(
    MICODE_FAMILY.map((client) => [client, MICODE_SUBMISSION_PARSER_VERSION])
  );
  const freeze = (reason: string): MiCodeTransitionPlan => ({
    mode: "freeze",
    parserVersions,
    warning: `Preserved MiMo Code and Xiaomi MiMo AI together: ${reason}. No MiMo token or cost changes were applied. Use an updated CLI and submit both micode and micode-desktop with an unfiltered, completely priced history rescan; missing credited history must be restored before this device can advance.`,
  });

  if (unknownStoredGeneration || args.isBackfill || !MICODE_FAMILY.every((client) =>
    ownValue(args.incomingVersions, client) === MICODE_SUBMISSION_PARSER_VERSION
  )) {
    return freeze("both surfaces must declare the supported parser generation");
  }
  if (!args.fullHistory) return freeze("this is not a full-history snapshot");
  if (args.contributions.some((day) =>
    day.clients.some((cell) => MICODE_FAMILY.some((client) => cell.client === client)) &&
    day.totals?.costIsComplete === false
  )) return freeze("the MiMo snapshot has incomplete pricing");

  const layouts: FamilyLayouts = {
    micode: foldParserClientSnapshot(args.contributions, "micode"),
    "micode-desktop": foldParserClientSnapshot(args.contributions, "micode-desktop"),
  };
  for (const { date, breakdown } of existingBreakdowns) {
    const previous = familyCoverage(MICODE_FAMILY.map((client) => ownValue(breakdown, client)));
    const incoming = familyCoverage(MICODE_FAMILY.map((client) => ownValue(layouts[client], date)));
    if (!covers(previous.total, incoming.total) || [...previous.models].some(
      ([id, count]) => !covers(count, incoming.models.get(id))
    )) return freeze(`the snapshot does not cover this device's credited MiMo day/model buckets (${date})`);
  }
  return {
    mode: "replace",
    parserVersions,
    layouts,
    warning: "Reconciled MiMo Code and Xiaomi MiMo AI together from the complete parser snapshot; previously credited desktop usage was transferred, not added again.",
  };
}
