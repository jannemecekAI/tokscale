import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import * as schema from "../../src/lib/db/schema";
import type { SubmissionData } from "../../src/lib/validation/submission";
import type { ClientBreakdownData } from "../../src/lib/db/helpers";
import { MICODE_FAMILY, MICODE_SUBMISSION_PARSER_VERSION } from "../../src/lib/db/micodeTransition";

const mocks = vi.hoisted(() => ({ db: { transaction: vi.fn() }, auth: vi.fn() }));
vi.mock("@/lib/db", async () => ({
  ...await vi.importActual("../../src/lib/db/schema"), db: mocks.db,
}));
vi.mock("@/lib/auth/personalTokens", () => ({ authenticatePersonalToken: mocks.auth }));
vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));
vi.mock("@/lib/db/usernameLookup", () => ({
  normalizeUsernameCacheKey: (value: string) => value.toLowerCase(), revalidateUsernamePaths: vi.fn(),
}));
vi.mock("@/lib/groups/cache", () => ({ revalidateUserGroupLeaderboards: vi.fn() }));
vi.mock("@/lib/leaderboard/getLeaderboard", () => ({ getLeaderboardData: vi.fn() }));

// Real schema validation, route, merge code, and SQL construction. Only the
// transaction transport is doubled. SQL is decoded by Drizzle's own dialect,
// and device SELECT predicates actually select the corresponding ledger.
let POST: typeof import("../../src/app/api/submit/route")["POST"];
beforeAll(async () => { POST = (await import("../../src/app/api/submit/route")).POST; });
const dialect = new PgDialect();
type Breakdown = Record<string, ClientBreakdownData>;
type Day = { id: string; deviceId: string; date: string; sourceBreakdown: Breakdown; timestampMs: null; activeTimeMs: null };
type Device = { id: string; parserVersions: Record<string, number>; parserStates: Record<string, unknown> };
let days: Day[];
let devices: Map<string, Device>;
let sequence: number;
let hasSubmission: boolean;
function totals(rows = days) {
  const cells = rows.flatMap((day) => Object.values(day.sourceBreakdown));
  return { tokens: cells.reduce((s, c) => s + c.tokens, 0), cost: cells.reduce((s, c) => s + c.cost, 0) };
}
function decode(query: SQL) { return dialect.sqlToQuery(query); }
function installStore() {
  const tx = {
    select(columns: Record<string, unknown>) {
      let predicate: SQL;
      const result = () => {
        if ("date" in columns && "sourceBreakdown" in columns) {
          const query = decode(predicate);
          expect(query.sql).toContain('"daily_breakdown"."submitted_device_id"');
          const deviceId = query.params.find((value) => [...devices.values()].some((d) => d.id === value));
          expect(deviceId).toBeDefined();
          return days.filter((day) => day.deviceId === deviceId);
        }
        if ("sourceBreakdown" in columns) return days;
        if ("totalTokens" in columns) {
          const sum = totals();
          return [{ totalTokens: sum.tokens, totalCost: sum.cost.toFixed(4), inputTokens: sum.tokens, outputTokens: 0,
            dateStart: days[0]?.date ?? null, dateEnd: days.at(-1)?.date ?? null, activeDays: days.length, rowCount: days.length, costIsComplete: true }];
        }
        if ("id" in columns && "sessionCount" in columns) return hasSubmission ? [{ id: "submission-one" }] : [];
        if ("sessionCount" in columns) return [{}];
        throw new Error(`Unexpected select: ${Object.keys(columns)}`);
      };
      const builder = {
        from: () => builder, for: () => builder, limit: () => builder,
        where: (sql: SQL) => { predicate = sql; return builder; },
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
      };
      return builder;
    },
    insert(table: unknown) {
      if (table === schema.submissions) {
        return {
          values: (value: Record<string, unknown>) => {
            expect(value.dateStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(value.dateEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            hasSubmission = true;
            return { returning: async () => [{ id: "submission-one" }] };
          },
        };
      }
      expect(table).toBe(schema.submittedDevices);
      let key: string;
      const builder = {
        values: (value: { deviceKey: string }) => { key = value.deviceKey; return builder; },
        onConflictDoUpdate: () => builder,
        returning: async () => {
          if (!devices.has(key)) devices.set(key, { id: `device-${key}`, parserVersions: {}, parserStates: {} });
          return [devices.get(key)!];
        },
      };
      return builder;
    },
    update(table: unknown) {
      let value: Record<string, unknown>;
      const builder = {
        set: (payload: Record<string, unknown>) => { value = payload; return builder; },
        where: async (predicate: SQL) => {
          if (table === schema.submissions) {
            expect(value.dateStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(value.dateEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          }
          if (table !== schema.submittedDevices || !("parserVersions" in value)) return;
          const device = [...devices.values()].find((d) => decode(predicate).params.includes(d.id));
          expect(device).toBeDefined();
          device!.parserVersions = structuredClone(value.parserVersions) as Device["parserVersions"];
          device!.parserStates = structuredClone(value.parserStates) as Device["parserStates"];
        },
      };
      return builder;
    },
    async execute(fragment: SQL) {
      const { sql, params } = decode(fragment);
      if (/INSERT INTO daily_breakdown\s*\(/.test(sql)) {
        expect(params.length % 11).toBe(0);
        for (let i = 0; i < params.length; i += 11) {
          const [, deviceId, date, tokens, cost, , , , , raw] = params.slice(i, i + 11);
          const sourceBreakdown = JSON.parse(raw as string) as Breakdown;
          const cells = Object.values(sourceBreakdown);
          expect(tokens).toBe(cells.reduce((s, c) => s + c.tokens, 0));
          expect(Number(cost)).toBeCloseTo(cells.reduce((s, c) => s + c.cost, 0), 4);
          expect(days.some((d) => d.deviceId === deviceId && d.date === date)).toBe(false);
          days.push({ id: `day-${++sequence}`, deviceId: deviceId as string, date: date as string, sourceBreakdown, timestampMs: null, activeTimeMs: null });
        }
      } else if (sql.includes("UPDATE daily_breakdown AS d SET")) {
        expect(params.length % 9).toBe(0);
        for (let i = 0; i < params.length; i += 9) {
          const [id, tokens, cost, , , , , raw] = params.slice(i, i + 9);
          const day = days.find((d) => d.id === id)!;
          expect(day).toBeDefined();
          day.sourceBreakdown = JSON.parse(raw as string) as Breakdown;
          const cells = Object.values(day.sourceBreakdown);
          expect(tokens).toBe(cells.reduce((s, c) => s + c.tokens, 0));
          expect(Number(cost)).toBeCloseTo(cells.reduce((s, c) => s + c.cost, 0), 4);
        }
      } else if (sql.includes("DELETE FROM daily_breakdown")) {
        days = days.filter((d) => !params.includes(d.id));
      }
    },
    async transaction(callback: (transaction: object) => Promise<unknown>): Promise<unknown> { return callback(tx); },
  };
  mocks.db.transaction.mockImplementation((callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx));
}
beforeEach(() => {
  days = []; devices = new Map(); sequence = 0; hasSubmission = true;
  mocks.auth.mockResolvedValue({ status: "valid", tokenId: "token-one", userId: "user-one", username: "alice" });
  installStore();
});

type Cell = { client: SubmissionData["summary"]["clients"][number]; input: number; messages?: number; model?: string; date?: string; cost?: number; cacheRead?: number };
function payload(cells: Cell[], options: { versions?: Record<string, number> | null; fullHistory?: boolean; device?: string; incomplete?: boolean; backfill?: boolean } = {}): SubmissionData {
  const contributions: SubmissionData["contributions"] = [];
  for (const cell of cells) {
    const date = cell.date ?? "2026-08-01";
    let day = contributions.find((d) => d.date === date);
    if (!day) {
      day = { date, intensity: 0, totals: { tokens: 0, cost: 0, messages: 0, ...(options.incomplete ? { costIsComplete: false } : {}) }, tokenBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, clients: [] };
      contributions.push(day);
    }
    const tokens = { input: cell.input, output: 0, cacheRead: cell.cacheRead ?? 0, cacheWrite: 0, reasoning: 0 };
    const cost = cell.cost ?? (cell.input + (cell.cacheRead ?? 0)) / 1_000_000;
    const messages = cell.messages ?? 1;
    day.clients.push({ client: cell.client, modelId: cell.model ?? "mimo-v2.5-pro", tokens, cost, messages });
    day.totals.tokens += tokens.input + tokens.cacheRead;
    day.totals.cost += cost; day.totals.messages += messages;
    day.tokenBreakdown.input += tokens.input; day.tokenBreakdown.cacheRead += tokens.cacheRead;
  }
  const tokens = contributions.reduce((s, d) => s + d.totals.tokens, 0);
  const cost = contributions.reduce((s, d) => s + d.totals.cost, 0);
  const dates = contributions.map((d) => d.date).sort();
  return {
    device: { id: options.device ?? "one" },
    meta: { generatedAt: "2026-08-02T00:00:00Z", version: "4.14.0", dateRange: { start: dates[0], end: dates.at(-1)! } },
    ...(options.versions === null ? {} : { scanScope: { parserVersions: options.versions ?? { micode: 2, "micode-desktop": 2 }, fullHistory: options.fullHistory ?? true } }),
    summary: { totalTokens: tokens, totalCost: cost, totalDays: contributions.length, activeDays: contributions.length, averagePerDay: cost / contributions.length, maxCostInSingleDay: Math.max(...contributions.map((d) => d.totals.cost)), clients: [...new Set(cells.map((c) => c.client))], models: [...new Set(cells.map((c) => c.model ?? "mimo-v2.5-pro"))] },
    contributions, years: [], ...(options.backfill ? { provenance: { origin: "backfill" } } : {}),
  };
}
async function submit(body: SubmissionData) {
  const response = await POST(new Request("http://localhost/api/submit", { method: "POST", headers: { authorization: "Bearer tt_valid", "content-type": "application/json" }, body: JSON.stringify(body) }));
  const json = await response.json();
  expect(response.status, JSON.stringify(json)).toBe(200);
  return json;
}
const split: Cell[] = [{ client: "micode", input: 500 }, { client: "micode-desktop", input: 1000 }];
async function seedLegacy() { await submit(payload([{ client: "micode", input: 1500, messages: 2 }], { versions: { micode: 1 } })); }
function cell(client: string, date = "2026-08-01", device = "device-one") {
  return days.find((d) => d.date === date && d.deviceId === device)?.sourceBreakdown[client];
}

describe("POST MiMo shared-store submission transition", () => {
  it("accepts the generation-2 wire contract through the real validator", async () => {
    const sender = readFileSync(resolve(__dirname, "../../../../crates/tokscale-cli/src/main.rs"), "utf8");
    expect(sender).toContain(`const MICODE_SUBMISSION_PARSER_VERSION: u32 = ${MICODE_SUBMISSION_PARSER_VERSION};`);
    hasSubmission = false;
    const result = await submit(payload(split));
    expect(result.metrics.totalTokens).toBe(1500);
    expect(devices.get("one")!.parserVersions).toEqual({ micode: 2, "micode-desktop": 2 });
    expect(cell("micode")!.tokens).toBe(500);
    expect(cell("micode-desktop")!.tokens).toBe(1000);
  });

  it("transfers legacy credit, replays identically, and credits covered growth exactly once", async () => {
    await seedLegacy();
    await submit(payload(split));
    expect(totals().tokens).toBe(1500);
    expect(cell("micode")!.tokens).toBe(500);
    expect(cell("micode-desktop")!.tokens).toBe(1000);
    const migrated = structuredClone(days);
    await submit(payload(split));
    expect(days).toEqual(migrated);
    const grown = payload([{ client: "micode", input: 700, messages: 2 }, split[1], { client: "micode-desktop", input: 300, date: "2026-08-02" }]);
    await submit(grown); await submit(grown);
    expect(totals().tokens).toBe(2000);
    expect(cell("micode")!.tokens).toBe(700);
    expect(cell("micode-desktop", "2026-08-02")!.tokens).toBe(300);
  });

  it("removes the old CLI label for entirely desktop history without doubling it", async () => {
    await seedLegacy();
    await submit(payload([{ client: "micode-desktop", input: 1500, messages: 2 }]));
    expect(cell("micode")).toBeUndefined();
    expect(cell("micode-desktop")!.tokens).toBe(1500);
    expect(totals().tokens).toBe(1500);
  });

  it.each([
    ["desktop-only", { versions: { "micode-desktop": 2 } }],
    ["CLI-only", { versions: { micode: 2 } }],
    ["date-filtered", { fullHistory: false }],
    ["unversioned", { versions: null }],
    ["original split generation", { versions: { micode: 1, "micode-desktop": 1 } }],
    ["unknown generation", { versions: { micode: 3, "micode-desktop": 3 } }],
    ["incomplete pricing", { incomplete: true }],
    ["backfill", { backfill: true }],
  ] as const)("freezes %s and makes the pending transition sticky", async (_name, options) => {
    await seedLegacy();
    const before = structuredClone(days);
    const result = await submit(payload(split, options));
    expect(days).toEqual(before);
    expect(result.warnings.join(" ")).toContain("No MiMo token or cost changes");
    expect(result.warnings.join(" ")).toContain("unfiltered");
    expect(devices.get("one")!.parserVersions.micode).toBe(2);
    // An old client cannot exploit a failed first transition to credit the
    // combined store alongside newly attributed desktop history.
    await submit(payload([{ client: "micode", input: 3000, messages: 3 }], { versions: { micode: 1 } }));
    expect(days).toEqual(before);
    await submit(payload(split));
    expect(cell("micode-desktop")!.tokens).toBe(1000);
  });

  it("does not add a surface-only generation-2 baseline on a new device", async () => {
    hasSubmission = false;
    const result = await submit(payload([split[0]], { versions: { micode: 2 } }));
    expect(totals().tokens).toBe(0);
    expect(result.warnings.join(" ")).toContain("both surfaces");
    await submit(payload(split));
    expect(totals().tokens).toBe(1500);
  });

  it("freezes truncated history even when unrelated model/day growth masks the lost total", async () => {
    await seedLegacy();
    const before = structuredClone(days);
    const result = await submit(payload([
      { client: "micode-desktop", input: 500 },
      { client: "micode", input: 5000, model: "new-model", date: "2026-08-02" },
    ]));
    expect(totals().tokens).toBe(1500);
    expect(days).toEqual(before);
    expect(result.warnings.join(" ")).toContain("credited MiMo day/model buckets");
  });

  it("rejects missing model or token-bucket coverage even with the same day total", async () => {
    await seedLegacy();
    for (const replacement of [
      { client: "micode-desktop" as const, input: 1500, messages: 2, model: "other-model" },
      { client: "micode-desktop" as const, input: 0, cacheRead: 1500, messages: 2 },
      { client: "micode-desktop" as const, input: 1500, messages: 1 },
    ]) {
      await submit(payload([replacement]));
      expect(cell("micode")!.tokens).toBe(1500);
      expect(cell("micode-desktop")).toBeUndefined();
    }
  });

  it("freezes rollback even if persisted generation markers are absent but desktop rows exist", async () => {
    await submit(payload(split));
    devices.get("one")!.parserVersions = {};
    await submit(payload([{ client: "micode", input: 1500, messages: 2 }], { versions: null }));
    expect(totals().tokens).toBe(1500);
    expect(cell("micode")!.tokens).toBe(500);
  });

  it("allows complete cost corrections but does not duplicate a cross-surface cost floor", async () => {
    await seedLegacy();
    await submit(payload(split.map((c) => ({ ...c, cost: 0 }))));
    expect(totals()).toEqual({ tokens: 1500, cost: 0 });
    expect(cell("micode")!.provenance?.costIsComplete).not.toBe(false);
  });

  it("freezes actual single-surface payloads without falsely filling in their sibling", async () => {
    await seedLegacy();
    for (const client of MICODE_FAMILY) {
      const result = await submit(payload([{ client, input: 2000, messages: 3 }], { versions: { [client]: 2 } }));
      expect(totals().tokens).toBe(1500);
      expect(result.warnings.join(" ")).toContain("both surfaces");
    }
  });

  it.each(["missing", "partial"])("preserves credited history with %s legacy model details", async (shape) => {
    await seedLegacy();
    const existing = cell("micode")!;
    existing.modelId = "legacy-model";
    if (shape === "missing") {
      existing.models = {};
    } else {
      existing.models["mimo-v2.5-pro"].tokens = 500;
      existing.models["mimo-v2.5-pro"].input = 500;
      existing.models["mimo-v2.5-pro"].messages = 1;
      existing.models["mimo-v2.5-pro"].cost = 0.0005;
    }
    const before = structuredClone(days);
    const wrong: Cell[] = shape === "missing"
      ? [{ client: "micode-desktop", input: 1500, messages: 2, model: "new-model" }]
      : [{ client: "micode-desktop", input: 500, messages: 1 },
         { client: "micode-desktop", input: 1000, messages: 1, model: "new-model" }];
    const result = await submit(payload(wrong));
    expect(days).toEqual(before);
    expect(result.warnings.join(" ")).toContain("No MiMo token or cost changes");
    const matching: Cell[] = shape === "missing"
      ? [{ client: "micode-desktop", input: 1500, messages: 2, model: "legacy-model" }]
      : [{ client: "micode-desktop", input: 500, messages: 1 },
         { client: "micode-desktop", input: 1000, messages: 1, model: "legacy-model" }];
    await submit(payload(matching));
    expect(cell("micode")).toBeUndefined();
    expect(cell("micode-desktop")!.models["legacy-model"].input).toBe(shape === "missing" ? 1500 : 1000);
    expect(totals().tokens).toBe(1500);
  });

  it("does not downgrade a stored future generation or clear its state", async () => {
    await submit(payload(split));
    const device = devices.get("one")!;
    device.parserVersions.micode = 3;
    device.parserStates.micode = { future: true };
    const before = structuredClone(days);
    await submit(payload([{ client: "micode-desktop", input: 2000, messages: 3 }]));
    expect(days).toEqual(before);
    expect(device.parserVersions.micode).toBe(3);
    expect(device.parserStates.micode).toEqual({ future: true });
  });

  it("keeps unrelated clients, parser states, and devices independent", async () => {
    await seedLegacy();
    const deviceOne = devices.get("one")!;
    deviceOne.parserVersions.other = 7; deviceOne.parserStates.other = { kept: true };
    await submit(payload([{ client: "claude", input: 20 }], { versions: { claude: 1 } }));
    const beforeOne = structuredClone(days);
    await submit(payload(split, { device: "two" }));
    expect(totals().tokens).toBe(3020);
    expect(days.filter((d) => d.deviceId === "device-one")).toEqual(beforeOne);
    const secondDevice = structuredClone(days.filter((d) => d.deviceId === "device-two"));
    // Frozen family does not freeze a healthy sibling client in the same POST.
    await submit(payload([...split, { client: "claude", input: 40 }], { versions: { "micode-desktop": 2, claude: 1 } }));
    expect(cell("micode")!.tokens).toBe(1500);
    expect(cell("claude")!.tokens).toBe(40);
    expect(days.filter((d) => d.deviceId === "device-two")).toEqual(secondDevice);
    await submit(payload(split));
    expect(cell("claude")!.tokens).toBe(40);
    expect(deviceOne.parserVersions.other).toBe(7);
    expect(deviceOne.parserStates.other).toEqual({ kept: true });
    expect(MICODE_FAMILY.every((client) => deviceOne.parserVersions[client] === 2)).toBe(true);
  });
});
