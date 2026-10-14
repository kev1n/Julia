import type { ReactElement } from "react";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { composerFloatingLayerProps } from "./composerEventScope";

/**
 * A main agent over two subagents. Stopped agents are red squares; running ones stay
 * circles, so each choice shows which agents it stops.
 */
function AgentTreeGlyph({ stopsSubagents }: { stopsSubagents: boolean }) {
  const child = (cx: number) =>
    stopsSubagents ? (
      <rect x={cx - 2} y={11} width={4} height={4} rx={1} className="fill-destructive" />
    ) : (
      <circle cx={cx} cy={13} r={2} className="fill-current" />
    );
  return (
    <svg viewBox="0 0 16 16" fill="none" className="text-muted-foreground" aria-hidden="true">
      <path
        d="M8 6v2.5M4 11V8.5h8V11"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinecap="round"
      />
      <rect x={6} y={1} width={4} height={4} rx={1} className="fill-destructive" />
      {child(4)}
      {child(12)}
    </svg>
  );
}

/**
 * Stop while subagents run: stop only the main agent, so a question can be asked while they
 * keep working, or stop everything.
 */
export function ComposerStopMenu(props: {
  trigger: ReactElement;
  subagentCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStop: (options: { keepSubagents: boolean }) => void;
}) {
  const subagents =
    props.subagentCount === 1 ? "its subagent" : `its ${props.subagentCount} subagents`;
  return (
    <Menu open={props.open} onOpenChange={props.onOpenChange}>
      <MenuTrigger render={props.trigger} />
      <MenuPopup align="end" side="top" {...composerFloatingLayerProps}>
        <MenuItem variant="destructive" onClick={() => props.onStop({ keepSubagents: false })}>
          <AgentTreeGlyph stopsSubagents />
          <span className="flex min-w-0 flex-col">
            <span>Stop all agents</span>
            <span className="text-muted-foreground text-xs">Main agent and {subagents}</span>
          </span>
        </MenuItem>
        <MenuItem onClick={() => props.onStop({ keepSubagents: true })}>
          <AgentTreeGlyph stopsSubagents={false} />
          <span className="flex min-w-0 flex-col">
            <span>Stop main agent</span>
            <span className="text-muted-foreground text-xs">
              {props.subagentCount === 1
                ? "Its subagent keeps"
                : `Its ${props.subagentCount} subagents keep`}{" "}
              running
            </span>
          </span>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
