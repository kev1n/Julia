import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.doUnmock("react");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fork theme default", () => {
  it("defaults fresh profiles to Codex following the system without replacing saved choices", async () => {
    const localStorage = createStorage();
    vi.stubGlobal("window", { localStorage });
    const { readThemePreference, readAppearanceModePreference } = await import("./useTheme");
    expect(readThemePreference()).toBe("codex");
    expect(readAppearanceModePreference(readThemePreference())).toBe("system");
    localStorage.setItem("t3code:theme", "system");
    expect(readThemePreference()).toBe("system");
    localStorage.setItem("t3code:theme", "ocean");
    expect(readThemePreference()).toBe("ocean");
    expect(readAppearanceModePreference(readThemePreference())).toBe("light");
    localStorage.setItem("t3code:theme-appearance-mode", "dark");
    expect(readAppearanceModePreference(readThemePreference())).toBe("dark");
  });
});
