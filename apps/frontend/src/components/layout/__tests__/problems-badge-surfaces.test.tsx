import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { BottomDock } from "../BottomDock";
import { StatusBar } from "../StatusBar";
import { useApp } from "@/lib/store";
import type { Diagnostic } from "@/lib/problem-matchers";

const initial = useApp.getState();

function diag(severity: Diagnostic["severity"], file = "/a.ts"): Diagnostic {
  return { source: "s", file, line: 1, column: 1, severity, message: "m" };
}

beforeEach(() => {
  useApp.setState({ ...initial, diagnostics: {} });
});

describe("Problems badge surfaces (task 3.7, R4)", () => {
  it("BottomDock pill sums errors+warnings across lsp:* and checker entries with error color", () => {
    useApp.setState({
      diagnostics: {
        "lsp:file:///a.ts": [diag("warning"), diag("info")],
        typescript: [diag("error"), diag("warning")],
      },
    });
    render(<BottomDock />);
    const pill = screen.getByTestId("problems-badge");
    // 1 error + 2 warnings (info excluded) = 3.
    expect(pill).toHaveTextContent("3");
    expect(pill.getAttribute("data-color")).toBe("error");
  });

  it("BottomDock pill uses warning color when there are warnings but no errors", () => {
    useApp.setState({ diagnostics: { "lsp:file:///a.ts": [diag("warning")] } });
    render(<BottomDock />);
    const pill = screen.getByTestId("problems-badge");
    expect(pill).toHaveTextContent("1");
    expect(pill.getAttribute("data-color")).toBe("warning");
  });

  it("BottomDock pill is hidden when there are no errors or warnings", () => {
    useApp.setState({ diagnostics: { "lsp:file:///a.ts": [diag("info"), diag("hint")] } });
    render(<BottomDock />);
    expect(screen.queryByTestId("problems-badge")).toBeNull();
  });

  it("StatusBar indicator reflects the derived count and color across sources", () => {
    useApp.setState({
      diagnostics: {
        "lsp:file:///a.ts": [diag("error")],
        cargo: [diag("warning")],
      },
    });
    render(<StatusBar />);
    const badge = screen.getByTestId("statusbar-problems-badge");
    expect(badge.getAttribute("data-count")).toBe("2");
    expect(badge.getAttribute("data-color")).toBe("error");
  });

  it("StatusBar hides the derived badge when there are no errors or warnings", () => {
    useApp.setState({ diagnostics: { "lsp:file:///a.ts": [diag("info")] } });
    render(<StatusBar />);
    expect(screen.queryByTestId("statusbar-problems-badge")).toBeNull();
  });
});
