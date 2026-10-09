# Aside helper (Owner's fork)

On each Mac environment that will host Aside tabs, install Aside in `/Applications`, install
Node, and run from the fork checkout:

```sh
bash fork/scripts/install-aside-helper.sh
```

Installation restarts Aside, so unlock 1Password in Aside afterward if needed. The helper is
installed outside the checkout and runs as a login LaunchAgent. T3 connects through
`~/.t3-aside/cdp.sock`; restarting T3 does not restart Aside. Only one T3 server can attach to
that helper at a time, so a dev server and the installed server cannot both use it concurrently.

Choose **Aside** from the browser panel's profile picker. Remote clients view the Aside running
on that environment, not the browser on their own device. Existing tabs opened outside T3 are
not imported into the panel. New tabs opened from a T3-managed tab, including native Aside
link clicks, are adopted into T3; closing them in T3 also closes them in Aside.

If Aside quits or the helper connection is lost, its tabs disappear from T3. Any tabs that
survive in Aside remain there, but reconnecting does not import them back into the panel.

Logs: `~/t3-fork/logs/aside-helper.log`. Re-run the installer to update the helper. To return to
Aside's normal launch (which also restarts it):

```sh
bash fork/scripts/install-aside-helper.sh --uninstall
```

Quitting Aside deliberately stops the helper too. To start it again without reinstalling:

```sh
launchctl kickstart -k gui/$(id -u)/com.example.t3code-fork.aside-helper
```

T3 brings a streamed Aside tab to the front when a viewer connects. Appearance, zoom, and
downloads stay native to Aside; downloads are saved on the host, not transferred to remote clients.
