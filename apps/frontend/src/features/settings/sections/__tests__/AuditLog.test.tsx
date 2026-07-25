import { test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AuditLogSection } from "../AuditLog";
import { __resetTrustForTests, checkAction } from "@/lib/trust";

const realLocalStorage = globalThis.localStorage;

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeStorage());
  __resetTrustForTests();
});
afterEach(() => {
  vi.stubGlobal("localStorage", realLocalStorage);
  __resetTrustForTests();
});

test("renders recorded permission decisions", () => {
  checkAction({ kind: "terminal", name: "rm -rf build" }); // restricted default → deny, recorded
  const { container } = render(<AuditLogSection />);
  expect(screen.getByText("rm -rf build")).toBeTruthy();
  expect(container.querySelectorAll("[data-audit-entry]").length).toBeGreaterThanOrEqual(1);
});

test("shows the empty state when nothing is recorded", () => {
  render(<AuditLogSection />);
  expect(screen.getByText("No decisions recorded yet.")).toBeTruthy();
});

test("Clear empties the audit log", () => {
  checkAction({ kind: "terminal", name: "npm run build" });
  const { container } = render(<AuditLogSection />);
  expect(container.querySelectorAll("[data-audit-entry]").length).toBeGreaterThanOrEqual(1);
  fireEvent.click(screen.getByText("Clear"));
  expect(container.querySelectorAll("[data-audit-entry]").length).toBe(0);
});
