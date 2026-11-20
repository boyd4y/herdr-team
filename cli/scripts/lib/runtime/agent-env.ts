const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"] as const;
const allowedProxyKeys = new Set(proxyKeys.flatMap(key => [key, key.toLowerCase()]));

export function readProxyEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries([...allowedProxyKeys].flatMap(key => {
    const value = env[key];
    return value === undefined ? [] : [[key, value]];
  }));
}

export function isProxyEnv(env: unknown): env is Record<string, string> {
  return Boolean(env && typeof env === "object" && !Array.isArray(env) &&
    Object.entries(env).every(([key, value]) => allowedProxyKeys.has(key) && typeof value === "string"));
}

export function desktopLaunchEnv(proxyEnv: Record<string, string>, roleEnv?: Record<string, string>): Record<string, string> {
  const inherited = { ...proxyEnv };
  for (const key of proxyKeys) {
    const lower = key.toLowerCase();
    if (roleEnv && (Object.hasOwn(roleEnv, key) || Object.hasOwn(roleEnv, lower))) {
      delete inherited[key];
      delete inherited[lower];
    }
  }
  return { ...(process.env["PATH"] ? { PATH: process.env["PATH"] } : {}), ...inherited, ...roleEnv };
}
