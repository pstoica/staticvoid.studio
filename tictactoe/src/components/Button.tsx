import type { ComponentProps, CSSProperties, ReactNode } from 'react';
import styles from './Button.module.css';

type NativeButtonProps = Omit<ComponentProps<'button'>, 'className' | 'style' | 'children'>;

export interface ButtonProps extends NativeButtonProps {
  children: ReactNode;
  /** drives --btn-hue so the chunky shadow/highlight tint tracks the parent's accent */
  hue?: number;
  block?: boolean;
  ghost?: boolean;
  className?: string;
}

export function Button({
  children,
  hue,
  block,
  ghost,
  type = 'button',
  className: classNameProp,
  ...rest
}: ButtonProps) {
  const className = [styles.btn, block && styles.btnBlock, ghost && styles.btnGhost, classNameProp]
    .filter(Boolean)
    .join(' ');

  const style = hue !== undefined ? ({ '--btn-hue': hue } as CSSProperties) : undefined;

  return (
    <button {...rest} type={type} className={className} style={style}>
      {children}
    </button>
  );
}
