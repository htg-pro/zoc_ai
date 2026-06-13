import { useEffect } from "react";
import { useApp } from "./store";

export function useGlobalShortcuts() {
  const togglePalette = useApp((s) => s.togglePalette);
  const setMainView = useApp((s) => s.setMainView);
  const setActivity = useApp((s) => s.setActivity);
  const toggleSide = useApp((s) => s.toggleSide);
  const toggleRight = useApp((s) => s.toggleRight);
  const toggleBottom = useApp((s) => s.toggleBottom);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        togglePalette();
      } else if (key === ",") {
        e.preventDefault();
        setMainView("settings");
      } else if (key === "b") {
        e.preventDefault();
        toggleSide();
      } else if (key === "j") {
        e.preventDefault();
        toggleBottom();
      } else if (key === "i") {
        e.preventDefault();
        toggleRight();
      } else if (key === "1") {
        e.preventDefault();
        setActivity("files");
      } else if (key === "2") {
        e.preventDefault();
        setActivity("indexer");
      } else if (key === "3") {
        e.preventDefault();
        setActivity("sessions");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePalette, setMainView, setActivity, toggleSide, toggleRight, toggleBottom]);
}
