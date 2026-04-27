import * as React from 'react';

import {
  Tabs as TabsPrimitive,
  TabsList as TabsListPrimitive,
  TabsTrigger as TabsTriggerPrimitive,
  TabsContent as TabsContentPrimitive,
  type TabsProps,
  type TabsListProps,
  type TabsTriggerProps,
  type TabsContentProps,
} from '@/components/animate-ui/primitives/radix/tabs';
import { cn } from '@/lib/utils';

function Tabs({ className, ...props }: TabsProps & { className?: string }) {
  return <TabsPrimitive className={cn('w-full', className)} {...props} />;
}

function TabsList({ className, ...props }: TabsListProps & { className?: string }) {
  return (
    <TabsListPrimitive
      className={cn(
        'inline-flex h-10 w-full items-center rounded-xl border border-slate-700 bg-[#030712] p-1 text-slate-300',
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: TabsTriggerProps & { className?: string }) {
  return (
    <TabsTriggerPrimitive
      className={cn(
        'inline-flex flex-1 items-center justify-center whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold text-slate-300 transition data-[state=active]:bg-cyan-500 data-[state=active]:text-slate-950',
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: TabsContentProps & { className?: string }) {
  return <TabsContentPrimitive className={cn('mt-3 outline-none', className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsContent, type TabsProps, type TabsListProps, type TabsTriggerProps, type TabsContentProps };
