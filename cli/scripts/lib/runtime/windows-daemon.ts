import { dlopen, ptr } from "bun:ffi";

const wide = (value: string) => Buffer.from(value + "\0", "utf16le");

/** Quote arguments for the process's Windows argv parser, without invoking a shell. */
export function windowsCommandLine(argv: string[]): string {
  return argv.map(value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&') + '"').join(" ");
}

/** Keep the team daemon alive after the launching Herdr terminal's job closes. */
export function spawnWindowsDaemon(argv: string[], cwd: string, env: Record<string, string>, logPath: string): number {
  if (!["x64", "arm64"].includes(process.arch)) throw new Error("The team daemon requires 64-bit Windows");
  // Bun's detached spawn does not request CREATE_BREAKAWAY_FROM_JOB.
  const lib = dlopen("kernel32.dll", {
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    InitializeProcThreadAttributeList: { args: ["ptr", "u32", "u32", "ptr"], returns: "i32" },
    UpdateProcThreadAttribute: { args: ["ptr", "u32", "u64", "ptr", "u64", "ptr", "ptr"], returns: "i32" },
    DeleteProcThreadAttributeList: { args: ["ptr"], returns: "void" },
    CreateProcessW: { args: ["ptr", "ptr", "ptr", "ptr", "i32", "u32", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
  });
  const api = lib.symbols;
  const check = (ok: number | boolean, operation: string) => {
    if (!ok) {
      const error = api.GetLastError();
      throw new Error(`Cannot start team daemon on Windows (${operation}, error ${error})`);
    }
  };
  const handles: bigint[] = [];
  let attributes: Uint8Array | undefined;
  try {
    // 64-bit SECURITY_ATTRIBUTES. Only these redirected handles may be inherited.
    const security = new Uint32Array([24, 0, 0, 0, 1, 0]);
    const redirect = (file: string, access: number, disposition: number) => {
      const handle = api.CreateFileW(wide(file), access, 7, security, disposition, 0x80, 0n);
      check(handle !== 0xffff_ffff_ffff_ffffn, "open daemon output");
      handles.push(handle);
      return handle;
    };
    const input = redirect("NUL", 0x8000_0000, 3);
    const output = redirect(logPath, 0x0010_0004, 4); // SYNCHRONIZE | FILE_APPEND_DATA

    const size = new BigUint64Array(1);
    api.InitializeProcThreadAttributeList(null, 1, 0, size);
    const buffer = new Uint8Array(Number(size[0]));
    check(api.InitializeProcThreadAttributeList(buffer, 1, 0, size), "initialize startup attributes");
    attributes = buffer;
    const inherited = new BigUint64Array([input, output]);
    check(api.UpdateProcThreadAttribute(attributes, 0, 0x0002_0002n /* HANDLE_LIST */,
      inherited, BigInt(inherited.byteLength), null, null), "redirect daemon output");

    // 64-bit STARTUPINFOEXW. Its final pointer references the initialized attribute list.
    const startup = new Uint8Array(112);
    const fields = new DataView(startup.buffer);
    fields.setUint32(0, startup.byteLength, true);
    fields.setUint32(60, 0x100 /* STARTF_USESTDHANDLES */, true);
    fields.setBigUint64(80, input, true);
    fields.setBigUint64(88, output, true);
    fields.setBigUint64(96, output, true);
    fields.setBigUint64(104, BigInt(ptr(attributes)), true);
    const child = new Uint8Array(24); // PROCESS_INFORMATION
    const environment = Object.entries(env).sort(([a], [b]) => a.toUpperCase().localeCompare(b.toUpperCase()))
      .map(([key, value]) => `${key}=${value}\0`).join("");
    const flags = 0x0100_0000 /* BREAKAWAY_FROM_JOB */ | 0x0000_0008 /* DETACHED_PROCESS */ |
      0x0000_0400 /* UNICODE_ENVIRONMENT */ | 0x0008_0000 /* EXTENDED_STARTUPINFO_PRESENT */;
    check(api.CreateProcessW(wide(argv[0]!), wide(windowsCommandLine(argv)), null, null, 1,
      flags, wide(environment), wide(cwd), startup, child), "create a process outside the terminal job");
    const processInfo = new DataView(child.buffer);
    handles.push(processInfo.getBigUint64(0, true), processInfo.getBigUint64(8, true));
    return processInfo.getUint32(16, true);
  } finally {
    if (attributes) api.DeleteProcThreadAttributeList(attributes);
    for (const handle of handles) api.CloseHandle(handle);
    lib.close();
  }
}
