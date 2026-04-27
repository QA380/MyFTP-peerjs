import * as React from 'react';
import { Tabs as TabsPrimitive } from 'radix-ui';

const Tabs = TabsPrimitive.Root;
const TabsList = TabsPrimitive.List;
const TabsTrigger = TabsPrimitive.Trigger;
const TabsContent = TabsPrimitive.Content;

export {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  type TabsProps,
  type TabsListProps,
  type TabsTriggerProps,
  type TabsContentProps,
};

type TabsProps = React.ComponentProps<typeof TabsPrimitive.Root>;
type TabsListProps = React.ComponentProps<typeof TabsPrimitive.List>;
type TabsTriggerProps = React.ComponentProps<typeof TabsPrimitive.Trigger>;
type TabsContentProps = React.ComponentProps<typeof TabsPrimitive.Content>;
