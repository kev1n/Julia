import type { ColorValue } from "react-native";
import Svg, { Path, Circle } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

/** Julia's monogram, matching the web JuliaMark. */
export function JuliaMark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  /** Uniwind accent-* utility for the SVG color prop, not a text-* utility. */
  readonly colorClassName?: string;
  readonly wordmark?: boolean;
}) {
  return (
    <Svg
      accessibilityLabel="Julia"
      height={props.height}
      width={props.wordmark ? props.height * 0.75 : props.height}
      viewBox={props.wordmark ? "5 0 24 32" : "0 0 32 32"}
      fill="none"
    >
      <ThemedPath
        d="M15 10h9v11a8 8 0 0 1-16 0"
        color={props.color}
        colorClassName={props.colorClassName}
        stroke="currentColor"
        strokeWidth={3.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx={24} cy={4} r={2} fill="#9dcebc" />
    </Svg>
  );
}
