import type { ButtonHTMLAttributes, ReactNode } from "react";

export default function MenuAction({
  children,
  shortcut,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  shortcut?: string;
}) {
  return (
    <button {...props}>
      <span>{children}</span>
      {shortcut && <kbd aria-hidden="true">{shortcut}</kbd>}
    </button>
  );
}
