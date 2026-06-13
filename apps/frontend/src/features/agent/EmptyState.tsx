import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Shared empty-state card used across the Agent Panel tabs. Renders a centered
 * card with an icon chip, title, optional description, optional bullet hints,
 * and an optional action footer. Keeps the six tabs visually consistent so no
 * tab shows a bare one-line placeholder.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  bullets,
  actions,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  bullets?: ReactNode[];
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <Card className={cn("w-full max-w-sm bg-card/40", className)}>
        <CardHeader className="items-center text-center">
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
            <Icon className="h-5 w-5 text-primary" />
          </div>
          <CardTitle className="text-sm">{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        {bullets && bullets.length > 0 ? (
          <CardContent className="pt-0">
            <ul className="space-y-1 text-xs text-muted-foreground">
              {bullets.map((bullet, i) => (
                <li key={i} className="flex gap-1.5">
                  <span aria-hidden className="text-primary">
                    ›
                  </span>
                  <span className="min-w-0">{bullet}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        ) : null}
        {actions ? (
          <CardFooter className="flex-wrap justify-center gap-2 pt-0">{actions}</CardFooter>
        ) : null}
      </Card>
    </div>
  );
}
