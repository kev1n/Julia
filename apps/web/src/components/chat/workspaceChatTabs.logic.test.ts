import { expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { workspaceChatKey } from "./workspaceChatTabs.logic";

it("shares tabs only within the same environment, project and checkout", () => {
  const root = {
    environmentId: EnvironmentId.make("local"),
    projectId: ProjectId.make("repo"),
    worktreePath: null,
  };
  const worktree = { ...root, worktreePath: "/repo/worktrees/feature" };
  expect(workspaceChatKey({ ...worktree, worktreePath: worktree.worktreePath + "/" })).toBe(
    workspaceChatKey(worktree),
  );
  expect(workspaceChatKey(worktree)).not.toBe(workspaceChatKey(root));
  expect(workspaceChatKey({ ...worktree, environmentId: EnvironmentId.make("remote") })).not.toBe(
    workspaceChatKey(worktree),
  );
  expect(workspaceChatKey({ ...worktree, projectId: ProjectId.make("other-repo") })).not.toBe(
    workspaceChatKey(worktree),
  );
});
