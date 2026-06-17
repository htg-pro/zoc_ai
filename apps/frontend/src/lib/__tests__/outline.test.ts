import { describe, expect, it } from "vitest";
import { extractOutline, filterOutline } from "@/lib/outline";

describe("extractOutline — TypeScript/JavaScript", () => {
  it("extracts functions, classes, interfaces, types, enums and const arrows", () => {
    const src = [
      "export function alpha() {}", // 1
      "async function beta() {}", // 2
      "export abstract class Gamma {}", // 3
      "interface Delta {}", // 4
      "export type Epsilon = string;", // 5
      "enum Zeta { A, B }", // 6
      "export const eta = () => 1;", // 7
      "const theta = async (x: number): number => x;", // 8
      "const notASymbol = 42;", // 9 (no match)
    ].join("\n");
    const out = extractOutline(src, "typescript");
    expect(out).toEqual([
      { name: "alpha", kind: "function", line: 1 },
      { name: "beta", kind: "function", line: 2 },
      { name: "Gamma", kind: "class", line: 3 },
      { name: "Delta", kind: "interface", line: 4 },
      { name: "Epsilon", kind: "type", line: 5 },
      { name: "Zeta", kind: "enum", line: 6 },
      { name: "eta", kind: "function", line: 7 },
      { name: "theta", kind: "function", line: 8 },
    ]);
  });

  it("treats unknown languages as TS/JS", () => {
    const out = extractOutline("function jsFn() {}", "javascriptreact");
    expect(out).toEqual([{ name: "jsFn", kind: "function", line: 1 }]);
  });
});

describe("extractOutline — Python", () => {
  it("extracts defs (incl. indented methods) and classes", () => {
    const src = ["class Foo:", "    def method(self):", "        pass", "def top():", "    pass"].join("\n");
    const out = extractOutline(src, "python");
    expect(out).toEqual([
      { name: "Foo", kind: "class", line: 1 },
      { name: "method", kind: "function", line: 2 },
      { name: "top", kind: "function", line: 4 },
    ]);
  });
});

describe("extractOutline — Rust", () => {
  it("extracts fn, struct, enum, trait", () => {
    const src = [
      "pub fn run() {}",
      "struct Point {}",
      "pub enum Color {}",
      "trait Draw {}",
    ].join("\n");
    const out = extractOutline(src, "rust");
    expect(out).toEqual([
      { name: "run", kind: "function", line: 1 },
      { name: "Point", kind: "struct", line: 2 },
      { name: "Color", kind: "enum", line: 3 },
      { name: "Draw", kind: "interface", line: 4 },
    ]);
  });
});

describe("extractOutline — Go", () => {
  it("extracts funcs (incl. receivers), structs and interfaces", () => {
    const src = [
      "func Main() {}",
      "func (s *Server) Serve() {}",
      "type User struct {",
      "type Reader interface {",
    ].join("\n");
    const out = extractOutline(src, "go");
    expect(out).toEqual([
      { name: "Main", kind: "function", line: 1 },
      { name: "Serve", kind: "function", line: 2 },
      { name: "User", kind: "struct", line: 3 },
      { name: "Reader", kind: "interface", line: 4 },
    ]);
  });
});

describe("filterOutline", () => {
  const symbols = extractOutline(
    ["function loadUser() {}", "function saveUser() {}", "function reset() {}"].join("\n"),
    "ts",
  );

  it("returns all symbols for an empty query", () => {
    expect(filterOutline(symbols, "  ")).toHaveLength(3);
  });

  it("matches case-insensitive substrings", () => {
    expect(filterOutline(symbols, "USER").map((s) => s.name)).toEqual([
      "loadUser",
      "saveUser",
    ]);
  });

  it("returns nothing when no symbol matches", () => {
    expect(filterOutline(symbols, "zzz")).toEqual([]);
  });
});
