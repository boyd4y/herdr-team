import { BoxRenderable, ScrollBoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import { sanitize } from "../shared/text.ts";
import { consoleColors as c } from "./console-theme.ts";
import type { RoleStatus } from "./status.ts";

/** A keyed native table: changing one assignment must not recreate the entire team's widgets. */
export function createRolesView(renderer: CliRenderer) {
  const view = new ScrollBoxRenderable(renderer, { id: "roles", title: "ROLES", border: true,
    borderColor: c.border, focusedBorderColor: c.purple, titleColor: c.purple, flexShrink: 0, scrollY: true });
  const rows = new Map<string, { view: BoxRenderable; cells: TextRenderable[] }>();
  let signature = "";
  const update = (roles: RoleStatus[]) => {
    const next = JSON.stringify(roles);
    if (signature === next) return;
    signature = next;
    view.title = `ROLES ${roles.length}`;
    const nameWidth = Math.max(5, ...roles.map(role => Bun.stringWidth(role.role))) + 1;
    const data = [{ id: "roles-heading", values: ["ROLE", "STATE", "TASKS", "Q"], color: c.muted }, ...roles.map(role => ({
      id: `role-${role.role}`, values: [role.role, role.herdrStatus === "per-task" ? "task" : role.herdrStatus,
        role.current?.map(id => `#${id}`).join(", ") || "—", String(role.queued ?? 0)],
      color: role.herdrStatus === "blocked" || role.herdrStatus === "ambiguous" ? c.red : role.current?.length ? c.green : c.text,
    }))];
    const ids = new Set(data.map(row => row.id));
    for (const [id, row] of rows) {
      if (ids.has(id)) continue;
      row.view.destroyRecursively(); rows.delete(id);
    }
    data.forEach((item, index) => {
      let row = rows.get(item.id);
      if (!row) {
        const line = new BoxRenderable(renderer, { id: item.id, height: 1, width: "100%", flexDirection: "row", flexShrink: 0 });
        const cells = ([{ maxWidth: "50%" }, { width: "25%", fg: c.muted },
          { flexGrow: 1, flexBasis: 0, fg: c.text }, { width: 2, fg: c.muted }] as const)
          .map(layout => new TextRenderable(renderer, { height: 1, truncate: true, minWidth: 0, ...layout }));
        for (const cell of cells) line.add(cell);
        row = { view: line, cells }; rows.set(item.id, row);
      }
      row.cells[0]!.width = nameWidth; row.cells[0]!.fg = item.color;
      item.values.forEach((value, i) => { row!.cells[i]!.content = sanitize(value); });
      view.add(row.view, index);
    });
  };
  return { view, update };
}
