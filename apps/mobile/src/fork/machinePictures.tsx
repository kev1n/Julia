/**
 * Fork (Owner): the product pictures of Owner's two machine kinds where the
 * app draws an environment's machine glyph, the same bundled images the
 * desktop uses (apps/web/src/fork/machinePictures). Other kinds keep T3's glyph.
 */
import type { EnvironmentMachineKind } from "@t3tools/contracts";
import { Image } from "expo-image";

const PICTURE_BY_KIND: Partial<Record<EnvironmentMachineKind, number>> = {
  laptop: require("../../../web/src/fork/machinePictures/macbook-pro-16-space-black.png"),
  "mac-mini": require("../../../web/src/fork/machinePictures/mac-mini-2024.png"),
};

export function hasMachinePicture(kind: EnvironmentMachineKind): boolean {
  return PICTURE_BY_KIND[kind] !== undefined;
}

export function MachinePicture(props: {
  readonly kind: EnvironmentMachineKind;
  readonly size: number;
  readonly accessibilityLabel: string;
}) {
  const source = PICTURE_BY_KIND[props.kind];
  // A glyph is square; the pictures are wide, so they take the glyph's height
  // and half again its width, as the desktop's environment lists do (h-8 w-12).
  return (
    <Image
      source={source}
      contentFit="contain"
      accessibilityLabel={props.accessibilityLabel}
      style={{ width: props.size * 1.5, height: props.size }}
    />
  );
}
