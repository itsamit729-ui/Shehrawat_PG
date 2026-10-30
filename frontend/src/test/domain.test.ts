import { describe, it, expect } from "vitest";
import { seed } from "../seed";
import {
  filterProperties,
  applyReceipt,
  invoiceBalance,
  canReply,
  csvText,
  safeExternalUrl,
} from "../domain";
describe("business UI rules", () => {
  it("contains exactly 500 bed records and no duplicate IDs", () => {
    const d = seed();
    expect(d.beds).toHaveLength(500);
    expect(new Set(d.beds.map((b) => b.id)).size).toBe(500);
  });
  it("combines location, sharing, gender and budget filters", () => {
    const p = filterProperties(
      seed().properties,
      "Sector 45",
      "Women",
      14000,
      "double",
    );
    expect(p.map((x) => x.id)).toEqual(["lotus"]);
  });
  it("does not treat a partial receipt as fully paid", () => {
    const i = seed().invoices[0];
    const next = applyReceipt(i, 1000);
    expect(next.status).toBe("Part paid");
    expect(invoiceBalance(next)).toBe(i.amount - 1000);
  });
  it("rejects overpayment, invalid and negative receipts", () => {
    const i = seed().invoices[0];
    for (const amount of [0, -1, NaN, i.amount + 1])
      expect(() => applyReceipt(i, amount)).toThrow();
  });
  it("marks an invoice paid exactly at its balance", () => {
    const i = seed().invoices[0];
    expect(applyReceipt(i, i.amount).status).toBe("Paid");
  });
  it("closes free-form replies exactly at the 24-hour boundary", () => {
    expect(
      canReply("2026-10-29T12:00:00Z", Date.parse("2026-10-30T12:00:00Z")),
    ).toBe(false);
    expect(
      canReply("2026-10-29T12:00:00Z", Date.parse("2026-10-30T11:59:59Z")),
    ).toBe(true);
  });
  it("escapes CSV formulas, quotes and newlines", () => {
    const csv = csvText([{ name: "=SUM(A1)", note: 'a,"b"\nc' }]);
    expect(csv).toContain("'=SUM(A1)");
    expect(csv).toContain('"a,""b""\nc"');
  });
  it("rejects executable and insecure redirect URLs", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("http://example.com")).toBeNull();
    expect(safeExternalUrl("https://example.com/pay")).toBe(
      "https://example.com/pay",
    );
  });
});
