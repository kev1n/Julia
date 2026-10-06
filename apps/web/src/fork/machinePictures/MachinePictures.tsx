/**
 * Fork (Owner): real pictures of his machines where T3 draws a machine icon, with the Lucide
 * icons' props so callers' size classes apply. Bundled (Apple product images, 240 px), never
 * hotlinked.
 */
import type { EnvironmentMachineKind } from "@t3tools/contracts";
import type { FunctionComponent } from "react";
import type { LucideProps } from "lucide-react";

import { cn } from "../../lib/utils";
import macMiniUrl from "./mac-mini-2024.png";
import macBookProUrl from "./macbook-pro-16-space-black.png";

// A one-pixel halo keeps the space-black laptop readable on dark surfaces and
// the silver mini readable on light ones.
const LEGIBLE = "object-contain drop-shadow-xs dark:drop-shadow-foreground/50";

function picture(src: string, alt: string) {
  function MachinePicture({ className, style, "aria-hidden": ariaHidden }: LucideProps) {
    return (
      <img
        src={src}
        alt={ariaHidden ? "" : alt}
        aria-hidden={ariaHidden}
        draggable={false}
        className={cn("inline-block shrink-0", LEGIBLE, className)}
        style={style}
      />
    );
  }
  return MachinePicture;
}

export const PICTURE_BY_KIND: Partial<
  Record<EnvironmentMachineKind, FunctionComponent<LucideProps>>
> = {
  laptop: picture(macBookProUrl, "MacBook Pro"),
  "mac-mini": picture(macMiniUrl, "Mac mini"),
};

/** The picture for a machine kind, or undefined to keep T3's icon. */
export function machinePicture(
  kind: EnvironmentMachineKind,
): FunctionComponent<LucideProps> | undefined {
  return PICTURE_BY_KIND[kind];
}

/**
 * Environment lists draw the machine at a size where the picture reads as the
 * machine; T3's glyph size stays for every other kind.
 */
export function machineRowIconClassName(kind: EnvironmentMachineKind, upstream: string): string {
  return PICTURE_BY_KIND[kind] ? "h-8 w-12" : upstream;
}
