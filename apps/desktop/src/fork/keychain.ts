/**
 * Fork: the fork app never touches the macOS keychain. An unnotarized rebuild would
 * prompt for the login password every time, so Chromium's mock keychain's fixed key is used and
 * saved pairings are protected by file permissions only, like ~/.t3's secrets.
 * Must run before the app is ready; imported for its side effect from main.ts.
 */
import * as Electron from "electron";

import { IS_FORK_APP } from "./profile.ts";

if (IS_FORK_APP) Electron.app.commandLine.appendSwitch("use-mock-keychain");
