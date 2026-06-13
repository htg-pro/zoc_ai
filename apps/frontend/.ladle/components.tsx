import type { GlobalProvider } from "@ladle/react";
import "../src/styles/globals.css";
import { TooltipProvider } from "../src/components/ui/tooltip";

export const Provider: GlobalProvider = ({ children, globalState }) => {
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("dark", globalState.theme !== "light");
  }
  return (
    <TooltipProvider delayDuration={150}>
      <div className="min-h-screen bg-background p-6 text-foreground">{children}</div>
    </TooltipProvider>
  );
};
