import * as React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'md', ...props }, ref) => {
    const baseClass = `
      inline-flex items-center justify-center rounded-xl 
      font-semibold transition outline-none
      disabled:cursor-not-allowed disabled:opacity-50
    `;

    const variantClass = {
      default: 'bg-cyan-500 text-slate-950 hover:bg-cyan-400 border border-transparent',
      destructive: 'border border-rose-500/50 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25',
      outline: 'border border-slate-700 bg-[#030712] text-slate-100 hover:bg-[#111827]',
      secondary: 'border border-emerald-500/50 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25',
      ghost: 'text-slate-400 hover:bg-slate-800 hover:text-slate-200',
    };

    const sizeClass = {
      sm: 'px-3 py-1.5 text-xs gap-1',
      md: 'px-4 py-2 text-sm gap-2',
      lg: 'px-6 py-3 text-base gap-2',
    };
    
    return (
      <button
        ref={ref}
        className={`${baseClass} ${variantClass[variant]} ${sizeClass[size]} ${className || ''}`.trim()}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';
export { Button, type ButtonProps };
