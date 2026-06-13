import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MonacoView } from "@/features/editor/MonacoView";
import type { OpenFile } from "@/lib/store";

type MockEditorProps = {
  className?: string;
  height?: number | string;
  width?: number | string;
  loading?: ReactNode;
  options?: Record<string, unknown>;
  wrapperProps?: Record<string, unknown>;
};

const mockEditorState = vi.hoisted(() => ({
  calls: [] as MockEditorProps[],
}));

vi.mock("@monaco-editor/react", async () => {
  const React = await import("react");

  return {
    default: (props: MockEditorProps) => {
      mockEditorState.calls.push(props);
      return React.createElement("div", { "data-testid": "mock-monaco-editor" }, props.loading);
    },
  };
});

const file: OpenFile = {
  path: "/src/App.tsx",
  name: "App.tsx",
  language: "typescript",
  content: "export function App() {\n  return null;\n}\n",
  dirty: false,
};

describe("MonacoView", () => {
  beforeEach(() => {
    mockEditorState.calls = [];
  });

  it("pins Monaco and its loading preview to the full editor surface", async () => {
    render(<MonacoView file={file} />);

    expect(await screen.findByTestId("mock-monaco-editor")).toBeInTheDocument();

    const props = mockEditorState.calls.at(-1);
    expect(props).toMatchObject({
      className: "h-full min-h-0 w-full min-w-0",
      height: "100%",
      width: "100%",
      wrapperProps: {
        className: "h-full min-h-0 w-full min-w-0 overflow-hidden",
      },
    });
    expect(props?.options).toMatchObject({
      automaticLayout: true,
      lineNumbers: "on",
      glyphMargin: true,
      minimap: { enabled: false },
    });

    const fallback = screen.getByTestId("editor-fallback");
    expect(fallback).toHaveClass("h-full", "w-full", "min-w-full", "overflow-auto");
    expect(fallback).toHaveTextContent("1");
    expect(fallback).toHaveTextContent("export function App()");
  });
});
