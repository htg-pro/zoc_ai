import { test, expect } from "vitest";
import { detectDestructiveIntent } from "../destructive-intent";

test("flags destructive phrasing with a label", () => {
  const cases: Array<[string, string]> = [
    ["please delete all the user records", "delete all"],
    ["run DROP TABLE users;", "drop table"],
    ["can you rm -rf /tmp/build", "rm -rf"],
    ["do a rm -fr ./dist", "rm -rf"],
    ["git reset --hard HEAD~3", "git reset --hard"],
    ["git clean -fd the tree", "git clean -f"],
    ["git push origin main --force", "git push --force"],
    ["TRUNCATE TABLE sessions", "truncate table"],
  ];
  for (const [text, label] of cases) {
    const result = detectDestructiveIntent(text);
    expect(result.destructive).toBe(true);
    expect(result.matched).toBe(label);
  }
});

test("does not flag benign phrasing", () => {
  for (const text of [
    "delete the temporary file at src/tmp.ts",
    "list all the files in the repo",
    "format the code with prettier",
    "reset the form state",
    "push the branch to origin",
    "add a table to the docs page",
  ]) {
    expect(detectDestructiveIntent(text)).toEqual({ destructive: false, matched: null });
  }
});
