import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { checking, exec, props, run, terminals, theme, watchFolder } from "herdr";
import { flowNodes, roleRows, scopedTerminals, sortTasks } from "./model.js";
import { sample } from "./sample.js";

export default class TeamConsole extends View {
  init(_props, cx) {
    this.binding = props()?.root && props()?.space ? { root: props().root, space: props().space, machine: props().machine ?? null } : null;
    this.preview = props()?.sample === true || !this.binding;
    this.tasks = []; this.roles = []; this.selected = null; this.error = null; this.loading = false;
    if (!checking() && !this.preview) this.load(cx);
  }

  load(cx) {
    if (this.closed || this.preview || !this.binding) return;
    if (this.loading) { this.refreshAgain = true; return; }
    const binding = this.binding;
    this.loading = true;
    this.watch(cx);
    cx.spawn(async cx => {
      try {
        const options = { cwd: binding.root, on: binding.machine, timeout: 10000 };
        // Existing read-only JSON contracts; no legacy runtime commands here.
        const results = await Promise.all([
          exec("herdr-team", ["tasks", "--root", binding.root, "--json"], options),
          exec("herdr-team", ["role", "list", "--root", binding.root, "--json"], options),
        ]);
        if (this.closed || this.preview) return;
        for (const result of results) if (result.code !== 0) throw new Error(result.stderr || "Cannot read team records");
        const [tasks, roles] = results.map(result => JSON.parse(result.stdout));
        if (!Array.isArray(tasks) || !Array.isArray(roles)) throw new Error("Expected task and role arrays from herdr-team");
        this.tasks = sortTasks(tasks); this.roles = roles; this.error = null;
      } catch (error) { if (!this.preview) this.error = String(error); }
      finally {
        this.loading = false;
        if (this.refreshAgain) { this.refreshAgain = false; this.load(cx); }
        cx.notify();
      }
    });
  }

  watch(cx) {
    if (this.closed || this.preview || !this.binding || this.binding.machine || this.watching) return;
    this.watching = true;
    cx.spawn(async cx => {
      try {
        while (!this.closed && !this.preview) {
          this.pendingWatch = watchFolder(`${this.binding.root}/.herdr`);
          const paths = await this.pendingWatch;
          this.pendingWatch = null;
          if (this.closed || this.preview) break;
          if (paths.length) this.load(cx);
        }
      } catch (error) { if (!this.preview) { this.watchError = `Live file updates unavailable; use Refresh. ${String(error)}`; cx.notify(); } }
      finally { this.watching = false; }
    });
  }

  close() { this.closed = true; this.pendingWatch?.cancel(); }

  toggle(cx) {
    this.preview = !this.preview;
    this.selected = null;
    if (this.preview) this.pendingWatch?.cancel();
    else this.load(cx);
    cx.notify();
  }

  render(cx) {
    const t = theme(), demo = this.preview ? sample() : null;
    const binding = demo?.binding ?? this.binding;
    const tasks = sortTasks(demo?.tasks ?? this.tasks);
    const live = scopedTerminals(demo?.terminals ?? terminals(), binding);
    const roles = roleRows(demo?.roles ?? this.roles, live);
    const task = tasks.find(task => task.id === this.selected) ?? tasks[0];
    const color = status => t[status === "error" ? "blocked" : status] ?? t.muted;
    const button = (id, text, action) => div().id(id).px(8).py(4).rounded(5).text_color(t.muted).hover(style => style.bg(t.hover)).on_click((_event, cx) => action(cx)).child(text);
    const section = title => div().text_size(11).font_semibold().text_color(t.dim).child(title);
    const list = tasks.map(task => h_flex().id(`task-${task.id}`).px(10).py(8).gap(8).rounded(6)
      .bg(task.id === (this.selected ?? tasks[0]?.id) ? t.selected : t.surface).hover(style => style.bg(t.hover))
      .on_click((_event, cx) => { this.selected = task.id; cx.notify(); })
      .child(div().text_color(t.accent).child(`#${task.id}`))
      .child(div().flex_1().truncate().child(task.title))
      .child(div().text_color(t.muted).child(`${task.status} · ${task.role}`)));
    const flow = flowNodes(task, roles).map((node, index) => h_flex().gap(8).items_center()
      .when(index > 0, element => element.child(div().text_color(t.dim).child("→")))
      .child(v_flex().p(10).gap(4).rounded(6).border(1).border_color(index ? t.border : t.accent)
        .child(h_flex().gap(6).items_center()
          .child(div().size(6).rounded(3).bg(color(node.status)).when(node.status === "working", element => element.loop("opacity", { from: 0.35, to: 1, period: 1200 })))
          .child(node.name))
        .child(div().text_size(11).text_color(color(node.status)).child(node.status))
        .child(div().text_size(11).text_color(t.muted).child(`${node.harness} · ${node.model}`))));
    const roleList = roles.map(role => h_flex().id(`role-${role.name}`).gap(8).py(5).items_center()
      .child(div().size(6).rounded(3).bg(color(role.status)))
      .child(div().w(58).font_semibold().child(role.name))
      .child(div().flex_1().truncate().text_color(t.muted).child(`${role.harness} · ${role.model ?? "default"}`))
      .child(div().text_color(t.dim).child(`${role.instances.length} live`))
      .when(!this.preview && role.instances.length === 1, element => element.child(button(`focus-${role.name}`, "Open", () => run("agent.focus", { terminal: role.instances[0].address })))));
    return v_flex().id("team-root").size_full().overflow_hidden().bg(t.surface).text_color(t.foreground).text_size(13).p(14).gap(12)
      .child(h_flex().items_center().gap(8).child(div().font_semibold().child("Team Console"))
        .child(div().text_size(11).text_color(this.preview ? t.accent : t.muted).child(this.preview ? "SAMPLE · no real work" : "READ-ONLY PREVIEW"))
        .child(div().flex_1())
        .child(button("sample", this.preview ? "Live" : "Sample", cx => this.toggle(cx)))
        .when(!this.preview && Boolean(binding), element => element.child(button("refresh", this.loading ? "Loading…" : "Refresh", cx => this.load(cx)))))
      .when(!this.preview, element => element.child(div().text_size(11).text_color(t.dim).child(binding ? `${binding.machine ?? "Local"} · ${binding.space} · ${binding.root}` : "Bind root and space in the mod props to read a team.")))
      .when(Boolean(this.error) && !this.preview, element => element.child(div().text_color(t.blocked).child(this.error)))
      .when(Boolean(this.watchError) && !this.preview, element => element.child(div().text_color(t.dim).child(this.watchError)))
      .child(section(`TASKS · ${tasks.length}`))
      .child(v_flex().id("task-list").h(190).overflow_y_scrollbar().gap(4).children(list)
        .when(!tasks.length, element => element.child(div().p(10).text_color(t.muted).child("No tasks. Use Sample to preview the layout."))))
      .child(v_flex().flex_1().min_h(0).gap(12)
        .child(v_flex().flex_1().min_h(0).gap(8).child(section("CURRENT → REMAINING ASSIGNEES"))
          .child(h_flex().id("flow").flex_1().overflow_x_scrollbar().items_center().gap(8).children(flow)))
        .child(v_flex().id("details").flex_1().min_h(0).overflow_y_scrollbar().gap(6).child(section("DETAIL"))
          .child(div().child(task?.title ?? "Select a task"))
          .when(Boolean(task), element => element.child(div().text_color(t.muted).child(`${task?.priority} · ${task?.status} · ${task?.role}`))
            .child(div().text_color(t.dim).child(`Dependencies: ${task?.dependsOn?.join(", ") || "none"}`))
            .child(div().text_size(11).text_color(t.dim).child("Display only. Status reports do not approve, hand off or complete tasks.")))))
      .child(section(`ROLES · ${roles.length}`))
      .child(v_flex().id("roles").max_h(180).overflow_y_scrollbar().children(roleList));
  }
}
