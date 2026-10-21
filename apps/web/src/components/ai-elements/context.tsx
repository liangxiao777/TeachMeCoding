"use client";

// Source: https://elements.ai-sdk.dev/api/registry/context.json
// Adapted to Base UI, Pi-reported token usage and unknown context occupancy.

import { Popover } from "@base-ui/react/popover";
import type { AgentContext } from "@teach-me-coding/contracts";
import { createContext, useContext, useMemo, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { formatNumber } from "@/i18n/format";

interface ContextSchema {
  usedTokens: number | null;
  maxTokens: number | null;
  usage: AgentContext["usage"];
}

const ContextContext = createContext<ContextSchema | null>(null);
const tokens = (value: number) => formatNumber(value, { notation: "compact", maximumFractionDigits: 1 });
const percent = (value: number) => formatNumber(value, { style: "percent", maximumFractionDigits: 1 });

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
  const { t } = useTranslation();
  const { ratio } = useContextValue();
  return (
    <Popover.Trigger openOnHover delay={200} render={<Button type="button" variant="ghost" size="xs"
      className={cn("gap-1.5 font-normal text-muted-foreground tabular-nums", className)} {...props} />}>
      <ContextIcon />
      {children ?? <span>{t('context.trigger', { usage: ratio === null ? "—" : percent(ratio) })}</span>}
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
  const { t } = useTranslation();
  const { usedTokens, maxTokens, ratio } = useContextValue();
  return (
    <div className={cn("space-y-3 p-3", className)} {...props}>
      <Popover.Title className="text-xs font-medium">{t('context.label')}</Popover.Title>
      {children ?? <>
        <div className="flex items-center justify-between gap-3 text-xs tabular-nums">
          <span>{ratio === null ? t('context.estimating') : percent(ratio)}</span>
          <span className="font-mono text-muted-foreground">
            {usedTokens === null ? "—" : tokens(usedTokens)} / {maxTokens === null ? "—" : tokens(maxTokens)}
          </span>
        </div>
        {ratio !== null && <Progress aria-label={t('context.label')} value={Math.max(0, Math.min(100, ratio * 100))} />}
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
    <span className="font-mono tabular-nums">{value === undefined ? "—" : tokens(value)}</span>
  </div>
);

export const ContextInputUsage = () => {
  const { t } = useTranslation();
  const { usage } = useContextValue();
  return <UsageRow label={t('context.input')} value={usage?.input} />;
};

export const ContextOutputUsage = () => {
  const { t } = useTranslation();
  const { usage } = useContextValue();
  return <UsageRow label={t('context.output')} value={usage?.output} />;
};

export const ContextCacheUsage = () => {
  const { t } = useTranslation();
  const { usage } = useContextValue();
  return <><UsageRow label={t('context.cacheRead')} value={usage?.cacheRead} /><UsageRow label={t('context.cacheWrite')} value={usage?.cacheWrite} /></>;
};
