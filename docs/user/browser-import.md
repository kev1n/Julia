# Import browser sessions

Import cookies from another browser into the desktop app's [preview browser](./browser.md) so you can reuse existing signed-in sessions.

## Import a profile

1. Close the source browser.
2. Open **Settings → Browser → Browser profiles → Add profile** and choose a browser under **Import from**.
3. Allow any OS keyring unlock prompt.

This is a one-time copy—later login changes stay separate, and some sites may still require signing in again.

## Platform notes

- **macOS (Safari)**: Requires temporary **Full Disk Access** (grant in System Settings, quit/reopen T3 Code if macOS requires it, then reopen the import wizard). You can revoke Full Disk Access afterward.
- **Windows**: Supports Firefox, Zen, and Helium profiles using standard encryption. Other Chromium browsers use app-bound encryption and cannot be imported.
- Partitioned cookies are skipped on all platforms. Administrators can disable cookie import via [managed policy](./managed-policy.md#other-capabilities).

## Use Aside directly (Owner's fork)

Choose **Aside** from the browser panel's profile picker to open a real Aside tab on the
connected environment's Mac. Its existing logins and extensions are available without importing
cookies. The page keeps Aside's window size and scales to fit the panel; change its size and
appearance in Aside itself.

The environment needs the [Aside helper setup](../operations/aside.md). Disconnecting T3 leaves
Aside running. Closing a browser tab closes that tab in Aside too.
