import contract from "@contracts/admin-contracts.json";
import { describe, expect, it } from "vitest";
import {
  accountPatchSchema,
  accountSummarySchema,
  adminContractSchemas,
  galleryItemSchema,
  requestLogSchema,
  settingsSchema,
} from "@/lib/schemas";

describe("admin contract schemas", () => {
  it.each(Object.entries(adminContractSchemas))("accepts the %s fixture", (name, schema) => {
    const fixture = (contract as Record<string, unknown>)[name];
    expect(fixture, `fixture is missing ${name}`).toBeDefined();
    const result = schema.safeParse(fixture);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("rejects a missing field", () => {
    const broken: Record<string, unknown> = { ...contract.accountSummary };
    delete broken.failCount;
    expect(accountSummarySchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a wrong field type", () => {
    const broken = { ...contract.accountSummary, failCount: "many" };
    expect(accountSummarySchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an invalid settings range", () => {
    const broken = { ...contract.settings, thumbnailWidth: 1 };
    expect(settingsSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts a patch without an api key", () => {
    expect(accountPatchSchema.safeParse({ name: "renamed" }).success).toBe(true);
    expect(accountPatchSchema.safeParse({ apiKey: "" }).success).toBe(true);
    expect(accountPatchSchema.safeParse({ unknown: true }).success).toBe(false);
  });

  it("requires attempts in request logs", () => {
    const broken: Record<string, unknown> = { ...contract.requestLog };
    delete broken.attempts;
    expect(requestLogSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts unclassified gallery rows", () => {
    const unclassified = { ...contract.galleryItem, nsfwTag: "unclassified", nsfwScores: null };
    expect(galleryItemSchema.safeParse(unclassified).success).toBe(true);
  });
});
