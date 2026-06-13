import { matchSlash, type SlashCommand } from "@/lib/slash-commands";

export function SlashAutocomplete({
  prefix,
  onPick,
}: {
  prefix: string;
  onPick: (c: SlashCommand) => void;
}) {
  const items = matchSlash(prefix);
  if (items.length === 0) return null;
  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 max-h-60 overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg">
      {items.map((c) => (
        <button
          key={c.name}
          type="button"
          onClick={() => onPick(c)}
          className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
        >
          <span className="font-mono text-primary">/{c.name}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate">{c.summary}</div>
            <div className="truncate font-mono text-[10px] text-muted-foreground">{c.hint}</div>
          </div>
        </button>
      ))}
    </div>
  );
}
