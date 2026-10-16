import type { InputFrame } from '../../core/contracts';
import type { ScreenId } from '../../core/systems';
import { ControlsPane } from '../controls-pane';
import type { UiCtx } from '../ctx';
import { h } from '../dom';
import { secondPlayerMatters, SETTINGS_TABS, type RowDef, type TabDef } from '../model';
import { FocusList, type FocusRow } from '../nav';
import { Osk } from '../osk';
import { actionRow, Dialog, selectRow, sliderRow, TabBar, textRow, toggleRow, type RowHandle } from '../widgets';
import { BaseScreen } from './base';

interface TabView {
  def: TabDef;
  el: HTMLElement;
  handles: RowHandle[];
  helps: { title: string; body: string }[];
  list: FocusList;
}

export class SettingsScreen extends BaseScreen {
  readonly id = 'settings' as const;
  private readonly tabs: TabBar;
  private readonly views: TabView[] = [];
  /** The tabs on show, as indexes of SETTINGS_TABS (the Assists tab of player 2 is there only while a second player matters), and the one open. */
  private shown: number[] = [];
  private tabIndex = 0;
  private returnTo: ScreenId = 'main';
  private readonly rowsHost = h('div', 'set-rows');
  private readonly helpTitle = h('div', 'help-title');
  private readonly helpBody = h('p', 'help-body');
  private readonly help = h('div', 'help', h('div', 'help-k', 'About this setting'), this.helpTitle, this.helpBody);
  private readonly side = h('div', 'set-side');
  private readonly controls: ControlsPane;
  private readonly dialog: Dialog;
  private readonly osk: Osk;

  constructor(ctx: UiCtx) {
    super(ctx, 'settings');
    this.dialog = new Dialog(ctx);
    this.osk = new Osk(ctx);
    this.controls = new ControlsPane(ctx);
    this.shown = this.tabsOnShow();
    this.tabs = new TabBar(ctx, this.shown.map((i) => ({ id: SETTINGS_TABS[i].id, label: this.tabLabel(i) })), (i) => this.showTab(i));
    SETTINGS_TABS.forEach((def, i) => this.views.push(this.buildView(def, i)));
    this.side.append(this.help, this.controls.el);
    this.el.append(
      h('div', 'scrim scrim-flat'),
      h('div', 'scrim scrim-vignette'),
      h('header', 'topbar', h('div', { cls: 'in', style: { '--d': '60', '--tx': '-60px' } }, h('div', 'kicker', 'Options'), h('h1', 'h1', 'Settings'))),
      h('div', { cls: 'set-tabs in', style: { '--d': '160', '--tx': '-40px' } }, this.tabs.el),
      h('div', { cls: 'panel chamfer edge settings-panel in', style: { '--d': '240', '--ty': '40px', '--tx': '0px' } }, this.rowsHost, this.side),
      this.prompts.el,
      this.dialog.el,
      this.osk.el,
    );
    this.prompts.set([
      { action: 'navigate', label: 'Select' },
      { action: 'adjust', label: 'Change' },
      { action: 'tabs', label: 'Tabs' },
      { action: 'back', label: 'Back' },
    ]);
    ctx.onSettings(() => this.refreshValues());
    this.showTab(0);
  }

  // ── building ───────────────────────────────────────────────────────────────

  private buildView(def: TabDef, tabIdx: number): TabView {
    const ctx = this.ctx;
    const el = h('div', 'rows');
    const handles: RowHandle[] = [];
    const helps: { title: string; body: string }[] = [];
    const rows: FocusRow[] = [];
    const list = new FocusList(false);
    const view: TabView = { def, el, handles, helps, list };

    const hover = (i: number) => () => {
      if (this.dialog.open || this.osk.open) return;
      if (list.focus(i)) ctx.sound('move');
    };
    const changed = (): void => {
      ctx.changed();
      for (const hd of handles) hd.refresh();
      this.controls.refresh();
    };

    def.rows.forEach((rd: RowDef, i) => {
      const opts = { showDesc: def.showDesc, onChange: changed, onHover: hover(i) };
      let handle: RowHandle;
      const getS = (): typeof ctx.settings => ctx.settings;
      switch (rd.kind) {
        case 'slider':
          handle = sliderRow(ctx, { label: rd.label, desc: rd.desc, min: rd.min, max: rd.max, step: rd.step, get: () => rd.get(getS()), set: (v) => rd.set(getS(), v), fmt: rd.fmt }, opts);
          break;
        case 'toggle':
          handle = toggleRow(ctx, { label: rd.label, desc: rd.desc, get: () => rd.get(getS()), set: (v) => rd.set(getS(), v) }, opts);
          break;
        case 'select':
          handle = selectRow(ctx, { label: rd.label, desc: rd.desc, options: rd.options, get: () => rd.get(getS()), set: (v) => rd.set(getS(), v), display: rd.display ? () => rd.display!(getS()) : undefined, wrap: rd.wrap }, opts);
          break;
        case 'text':
          handle = textRow(ctx, { label: rd.label, desc: rd.desc, maxLength: rd.maxLength, get: () => rd.get(getS()), set: (v) => rd.set(getS(), v) }, {
            ...opts,
            osk: (initial, max, done) => this.osk.show(rd.label, initial, max, done),
          });
          break;
      }
      const idx = rows.length;
      handles.push(handle);
      helps.push({ title: rd.label, body: rd.desc });
      handle.row.onFocus = () => {
        this.setHelp(view, idx);
        handle.el.scrollIntoView({ block: 'nearest' });
      };
      el.appendChild(handle.el);
      rows.push(handle.row);
    });

    const reset = actionRow(ctx, { label: 'Reset this tab to defaults', run: () => this.askReset(tabIdx) }, { onHover: hover(rows.length) });
    reset.el.classList.add('reset-row');
    const ridx = rows.length;
    reset.row.onFocus = () => {
      this.setHelp(view, ridx);
      reset.el.scrollIntoView({ block: 'nearest' });
    };
    helps.push({ title: 'Reset to defaults', body: `Puts every ${def.label.toLowerCase()} setting back to its original value.` });
    handles.push(reset);
    el.appendChild(reset.el);
    rows.push(reset.row);
    list.setRows(rows, 0);
    return view;
  }

  /** The tabs to show: all of them, but the one for player 2's aids only while a second player matters. */
  private tabsOnShow(): number[] {
    const two = secondPlayerMatters(this.ctx.players, this.ctx.split);
    return SETTINGS_TABS.map((_, i) => i).filter((i) => two || !SETTINGS_TABS[i].split);
  }

  /** The label of a tab (with player 2's tab up, the first Assists tab says whose it is). */
  private tabLabel(def: number): string {
    return SETTINGS_TABS[def].id === 'assists' && this.shown.some((i) => SETTINGS_TABS[i].split) ? 'Assists P1' : SETTINGS_TABS[def].label;
  }

  /** The player-2 tab comes and goes with the controllers and the split screen: keep the tab bar, and the tab open, in step. */
  private syncTabs(): void {
    const next = this.tabsOnShow();
    if (next.length === this.shown.length && next.every((v, i) => v === this.shown[i])) return;
    const open = this.shown[this.tabIndex];
    this.shown = next;
    const at = next.indexOf(open);
    this.tabs.setTabs(next.map((i) => this.tabLabel(i)));
    this.tabs.setIndex(at >= 0 ? at : 0);
    if (at !== this.tabIndex || at < 0) this.showTab(at >= 0 ? at : 0);
  }

  private askReset(tabIdx: number): void {
    const def = SETTINGS_TABS[tabIdx];
    this.dialog.show({
      title: 'Reset ' + def.label.toLowerCase() + '?',
      text: 'Every setting on this tab goes back to its default value.',
      yes: 'Reset',
      no: 'Cancel',
      onYes: () => {
        def.reset(this.ctx.settings);
        this.ctx.changed();
        this.refreshValues();
      },
    });
  }

  // ── tabs ───────────────────────────────────────────────────────────────────

  private view(): TabView {
    return this.views[this.shown[this.tabIndex]];
  }

  private showTab(i: number): void {
    this.tabIndex = i;
    this.rowsHost.replaceChildren(this.view().el);
    this.rowsHost.scrollTop = 0;
    const v = this.view();
    for (const hd of v.handles) hd.refresh();
    v.list.focus(0);
    const controlsTab = v.def.id === 'controls';
    this.controls.el.style.display = controlsTab ? '' : 'none';
    this.help.style.display = controlsTab ? 'none' : '';
    this.setHelp(v, Math.max(0, v.list.index));
    if (controlsTab) this.controls.resize();
  }

  private setHelp(v: TabView, idx: number): void {
    const hp = v.helps[idx];
    if (!hp) return;
    this.helpTitle.textContent = hp.title;
    this.helpBody.textContent = hp.body;
  }

  private refreshValues(): void {
    for (const v of this.views) for (const hd of v.handles) hd.refresh();
    this.controls.refresh();
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  enter(from: ScreenId): void {
    if (from === 'pause' || from === 'main') this.returnTo = from;
    this.dialog.hide();
    this.osk.open = false;
    this.osk.el.classList.remove('on');
    this.syncTabs();
    this.tabs.setIndex(0);
    this.showTab(0);
  }

  leave(): void {
    this.dialog.hide();
  }

  resize(): void {
    this.controls.resize();
  }

  refresh(): void {
    this.syncTabs();
    this.refreshValues();
  }

  live(f: InputFrame): void {
    if (this.view().def.id === 'controls') this.controls.update(f);
  }

  nav(f: InputFrame): void {
    if (this.osk.open) {
      this.osk.handle(f);
      return;
    }
    if (this.dialog.open) {
      this.dialog.handle(f.nav);
      return;
    }
    const n = f.nav;
    if (this.tabs.handle(n)) return;
    if (n.back) {
      this.ctx.sound('back');
      this.ctx.go(this.returnTo);
      return;
    }
    const r = this.view().list.handle(n);
    if (r === 'moved' || r === 'changed') this.ctx.sound('move');
    else if (r === 'activated') this.ctx.sound('select');
    else if (r === 'blocked') this.ctx.sound('error');
  }
}
