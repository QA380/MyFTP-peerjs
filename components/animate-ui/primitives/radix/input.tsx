import * as React from 'react';

const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & {
    error?: boolean;
    helperText?: string;
  }
>(({ className, error, helperText, ...props }, ref) => (
  <>
    <input
      ref={ref}
      className={`
        w-full rounded-xl border bg-[#030712]/80 px-3 py-2 text-sm 
        text-slate-100 outline-none transition
        ${error 
          ? 'border-rose-500 focus:border-rose-400' 
          : 'border-slate-700 focus:border-cyan-400'
        }
        disabled:cursor-not-allowed disabled:opacity-50
        ${className || ''}
      `.trim()}
      {...props}
    />
    {helperText && (
      <p className={`mt-1 text-xs ${error ? 'text-rose-300' : 'text-slate-400'}`}>
        {helperText}
      </p>
    )}
  </>
));

Input.displayName = 'Input';

export { Input };
export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  error?: boolean;
  helperText?: string;
};
