import { BoxRenderable, ScrollBoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import { sanitize } from "../shared/text.ts";
import { consoleColors as c } from "./console-theme.ts";
import type { RoleStatus } from "./status.ts";

/** A keyed native table: changing one assignment must not recreate the entire team's widgets. */
export function createRolesView(renderer: CliRenderer) {
  const view = new ScrollBoxRenderable(renderer, { id: "roles", title: "ROLES", border: true,
    borderColor: c.border, focusedBorderColor: c.purple, titleColor: c.purple, flexShrink: 0,
    scrollY: true, scrollX: true });
  const rows = new Map<string, { view: BoxRenderable; cells: TextRenderable[] }>();
  let signature = "";
  let width = 0;
  const update = (roles: RoleStatus[]) => {
    const next = JSON.stringify(roles);
    if (signature === next) return;
    signature = next;
    view.title = `ROLES ${roles.length}`;
    const data = [{ id: "roles-heading", values: ["ROLE", "HARNESS", "MODEL", "STATE", "TASKS", "Q"], color: c.muted }, ...roles.map(role => ({
      id: `role-${role.role}`, values: [role.role, role.kind, role.model, role.herdrStatus === "per-task" ? "task" : role.herdrStatus,
        role.current?.map(id => `#${id}`).join(", ") || "—", String(role.queued ?? 0)],
      color: role.herdrStatus === "blocked" || role.herdrStatus === "ambiguous" ? c.red : role.current?.length ? c.green : c.text,
    }))];
    for (const row of data) row.values = row.values.map(value => sanitize(value));
    const widths = data[0]!.values.map((_, index) => Math.max(...data.map(row => Bun.stringWidth(row.values[index]!))) + 1);
    width = widths.reduce((sum, value) => sum + value, 0);
    const ids = new Set(data.map(row => row.id));
    for (const [id, row] of rows) {
      if (ids.has(id)) continue;
      row.view.destroyRecursively(); rows.delete(id);
    }
    data.forEach((item, index) => {
      let row = rows.get(item.id);
      if (!row) {
        const line = new BoxRenderable(renderer, { id: item.id, height: 1, flexDirection: "row", flexShrink: 0 });
        const cells = item.values.map((_, index) => new TextRenderable(renderer, {
          height: 1, truncate: true, minWidth: 0, flexShrink: 0, fg: index === 4 ? c.text : c.muted,
        }));
        for (const cell of cells) line.add(cell);
        row = { view: line, cells }; rows.set(item.id, row);
      }
      row.view.width = width;
      row.cells[0]!.fg = item.color;
      item.values.forEach((value, i) => { row!.cells[i]!.width = widths[i]!; row!.cells[i]!.content = value; });
      if (view.getChildren()[index] !== row.view) view.add(row.view, index);
    });
  };
  return { view, update, get width() { return width; } };
}
