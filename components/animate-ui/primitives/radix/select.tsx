import * as React from 'react';
import { Select as SelectPrimitive } from 'radix-ui';

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;
const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={`
      w-full rounded-xl border border-slate-700 bg-[#030712]/80 px-3 py-2 text-sm 
      text-slate-100 outline-none transition focus:border-cyan-400
      disabled:cursor-not-allowed disabled:opacity-50
      ${className || ''}
    `.trim()}
    {...props}
  />
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      className={`
        relative z-50 rounded-xl border border-slate-700 bg-[#030712] 
        shadow-lg
        ${className || ''}
      `.trim()}
      {...props}
    />
  </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={`
      px-3 py-2 text-sm text-slate-100 outline-none transition
      hover:bg-slate-800 focus:bg-slate-800 data-[state=checked]:bg-cyan-500/20
      ${className || ''}
    `.trim()}
    {...props}
  />
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectItem,
};
