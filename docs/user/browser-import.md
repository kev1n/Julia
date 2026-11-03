# Import browser sessions

The desktop app can import cookies from another browser so you can reuse its signed-in sessions
in the preview browser.

Open **Settings → Browser → Browser profiles → Add profile**, then choose a browser under
**Import from**. Close the source browser before importing, and allow an operating-system keyring
unlock prompt if one appears.

This is a one-time copy. Later login changes stay separate between the two browsers, and some
sites may still require you to sign in again.

On macOS, Safari imports need Full Disk Access. Choose **Allow**, drag T3 Code into the
System Settings permission list, and turn access on. **Continue** becomes available when access
is detected. macOS may require you to quit and reopen T3 Code before the grant applies; reopen
the import wizard afterward. You can revoke Full Disk Access once the import is done.

On Windows, import supports Firefox, Zen, and Helium profiles that use standard profile encryption.
Other Chromium-based browsers use app-bound encryption and cannot be imported. Partitioned cookies
are skipped on all platforms.

## Use Aside directly (fork)

Choose **Aside** from the browser panel's profile picker to open a real Aside tab on the
connected environment's Mac. Its existing logins and extensions are available without importing
cookies. The page keeps Aside's window size and scales to fit the panel; change its size and
appearance in Aside itself.

The environment needs the [Aside helper setup](../operations/aside.md). Disconnecting T3 leaves
Aside running. Closing a browser tab closes that tab in Aside too.
