import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

/** Preserve work notes and tool inputs, but not the tool's returned data. */
export function withoutToolResults(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    case "command_execution": {
      const copy = { ...item };
      delete copy.output;
      delete copy.outputOmitted;
      delete copy.outputIndicatesFailure;
      delete copy.exitCode;
      return copy;
    }
    case "dynamic_tool": {
      const copy = { ...item };
      delete copy.output;
      delete copy.outputOmitted;
      delete copy.viewedImagePath;
      return copy;
    }
    case "file_change": {
      const copy = { ...item };
      delete copy.diffStr;
      delete copy.oldStr;
      delete copy.newStr;
      delete copy.changes;
      delete copy.additions;
      delete copy.deletions;
      return copy;
    }
    case "file_search":
    case "web_search": {
      const copy = { ...item };
      delete copy.results;
      return copy;
    }
    case "subagent":
      return { ...item, result: null };
    case "checkpoint":
      return { ...item, files: [] };
    default:
      return item;
  }
}
