/**
 * Fork (Owner): a paired client that can already run agents gets every standard permission at
 * read time, since upstream never widens a stored grant and Owner pairs only his own devices.
 * Read-only pairings, agent MCP tokens and CLI-issued sessions keep exactly what they were given.
 */
import {
  AuthOrchestrationOperateScope,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";

const PAIRED_CLIENT_SUBJECT = "one-time-token";

export function pairedOperatorScopes(
  subject: string,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
): ReadonlyArray<AuthEnvironmentScope> {
  if (subject !== PAIRED_CLIENT_SUBJECT || !scopes.includes(AuthOrchestrationOperateScope)) {
    return scopes;
  }
  const missing = AuthStandardClientScopes.filter((scope) => !scopes.includes(scope));
  return missing.length === 0 ? scopes : [...scopes, ...missing];
}
