"use client";

// Source: https://elements.ai-sdk.dev/api/registry/context.json
// Adapted to Base UI, Pi-reported token usage and unknown context occupancy.

import { Popover } from "@base-ui/react/popover";
import type { AgentContext } from "@teach-me-coding/contracts";
import { createContext, useContext, useMemo, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

interface ContextSchema {
  usedTokens: number | null;
  maxTokens: number | null;
  usage: AgentContext["usage"];
}

const ContextContext = createContext<ContextSchema | null>(null);
const tokens = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });

const useContextValue = () => {
  const context = useContext(ContextContext);
  if (!context) throw new Error("Context components must be used within Context");
  const ratio = context.usedTokens !== null && context.maxTokens !== null && context.maxTokens > 0
    ? context.usedTokens / context.maxTokens : null;
  return { ...context, ratio };
};

export type ContextProps = Popover.Root.Props & ContextSchema;

export const Context = ({ usedTokens, maxTokens, usage, ...props }: ContextProps) => {
  const value = useMemo(() => ({ usedTokens, maxTokens, usage }), [usedTokens, maxTokens, usage]);
  return <ContextContext.Provider value={value}><Popover.Root {...props} /></ContextContext.Provider>;
};

const ContextIcon = () => {
  const { ratio } = useContextValue();
  const circumference = 2 * Math.PI * 10;
  return (
    <svg aria-hidden="true" className="size-4" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.25"
        strokeDasharray={ratio === null ? "3 3" : undefined} />
      {ratio !== null && <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        strokeDasharray={circumference} strokeDashoffset={circumference * (1 - Math.max(0, Math.min(1, ratio)))}
        transform="rotate(-90 12 12)" />}
    </svg>
  );
};

export const ContextTrigger = ({ children, className, ...props }: ComponentProps<typeof Button>) => {
  const { ratio } = useContextValue();
  return (
    <Popover.Trigger openOnHover delay={200} render={<Button type="button" variant="ghost" size="xs"
      className={cn("gap-1.5 font-normal text-muted-foreground tabular-nums", className)} {...props} />}>
      <ContextIcon />
      {children ?? <span>上下文 {ratio === null ? "—" : percent.format(ratio)}</span>}
    </Popover.Trigger>
  );
};

export const ContextContent = ({ className, ...props }: Popover.Popup.Props) => (
  <Popover.Portal>
    <Popover.Positioner side="top" align="start" sideOffset={8} collisionPadding={12} className="isolate z-50">
      <Popover.Popup data-slot="context-content" className={cn(
        "w-72 max-w-[calc(100vw-24px)] divide-y overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none",
        className,
      )} {...props} />
    </Popover.Positioner>
  </Popover.Portal>
);

export const ContextContentHeader = ({ children, className, ...props }: ComponentProps<"div">) => {
  const { usedTokens, maxTokens, ratio } = useContextValue();
  return (
    <div className={cn("space-y-3 p-3", className)} {...props}>
      <Popover.Title className="text-xs font-medium">上下文占用</Popover.Title>
      {children ?? <>
        <div className="flex items-center justify-between gap-3 text-xs tabular-nums">
          <span>{ratio === null ? "待估算" : percent.format(ratio)}</span>
          <span className="font-mono text-muted-foreground">
            {usedTokens === null ? "—" : tokens.format(usedTokens)} / {maxTokens === null ? "—" : tokens.format(maxTokens)}
          </span>
        </div>
        {ratio !== null && <Progress aria-label="上下文占用" value={Math.max(0, Math.min(100, ratio * 100))} />}
      </>}
    </div>
  );
};

export const ContextContentBody = ({ className, ...props }: ComponentProps<"div">) => (
  <div className={cn("space-y-2 p-3", className)} {...props} />
);

const UsageRow = ({ label, value }: { label: string; value: number | undefined }) => (
  <div className="flex items-center justify-between gap-3 text-xs">
    <span className="text-muted-foreground">{label}</span>
    <span className="font-mono tabular-nums">{value === undefined ? "—" : tokens.format(value)}</span>
  </div>
);

export const ContextInputUsage = () => {
  const { usage } = useContextValue();
  return <UsageRow label="输入（不含缓存）" value={usage?.input} />;
};

export const ContextOutputUsage = () => {
  const { usage } = useContextValue();
  return <UsageRow label="输出" value={usage?.output} />;
};

export const ContextCacheUsage = () => {
  const { usage } = useContextValue();
  return <><UsageRow label="缓存读取" value={usage?.cacheRead} /><UsageRow label="缓存写入" value={usage?.cacheWrite} /></>;
};
