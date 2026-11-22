import path from "node:path";

/** Check offsets from path.relative without confusing sibling names with "..". */
export function outsideRoot(offset: string, paths: Pick<typeof path, "sep" | "isAbsolute"> = path): boolean {
  return offset === ".." || offset.startsWith(".." + paths.sep) || paths.isAbsolute(offset);
}
