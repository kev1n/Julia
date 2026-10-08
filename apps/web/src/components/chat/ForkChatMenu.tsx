import { useState } from "react";
import { GitForkIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ForkChatMenu(props: {
  disabled?: boolean;
  size?: "icon-lg" | "xs";
  label: string;
  onFork: (destination: "tab" | "thread") => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const fork = (destination: "tab" | "thread") => {
    setBusy(true);
    void props.onFork(destination).finally(() => setBusy(false));
  };
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  type="button"
                  size={props.size ?? "xs"}
                  variant="ghost"
                  disabled={props.disabled || busy}
                  aria-label={props.label}
                />
              }
            />
          }
        >
          <GitForkIcon aria-hidden className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup>{props.label} · conversation without tool results</TooltipPopup>
      </Tooltip>
      <MenuPopup>
        <MenuItem onClick={() => fork("tab")}>Fork to new tab</MenuItem>
        <MenuItem onClick={() => fork("thread")}>Fork to new thread</MenuItem>
      </MenuPopup>
    </Menu>
  );
}
