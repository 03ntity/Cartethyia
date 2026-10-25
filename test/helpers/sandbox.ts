/** User-owned configuration roots used by CLI-tool injectors on every OS. */
export const CONFIG_HOME_ENV = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME"] as const;

/** Redirects config resolution and restores the caller's exact environment. */
export function sandboxConfigHome(root: string): () => void {
  const previous = CONFIG_HOME_ENV.map((key) => [key, process.env[key]] as const);
  for (const key of CONFIG_HOME_ENV) process.env[key] = root;
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export function sandboxEnv(key: string, value: string): () => void {
  const previous = process.env[key];
  process.env[key] = value;
  return () => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  };
}
