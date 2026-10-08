import type { SVGProps } from "react";

/** Julia monogram, shared with the mobile mark and favicon. */
export function JuliaMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 32 32" {...props} fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M15 10h9v11a8 8 0 0 1-16 0"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="24" cy="4" r="2" fill="currentColor" />
    </svg>
  );
}
