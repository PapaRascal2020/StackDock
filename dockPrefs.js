// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

// The "Position", "Behaviour" and "Appearance" pages of the preferences
// window. Every option is a libadwaita row, so the window's search finds it.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {
    gettext as __,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {bindChoice} from './stacksPrefs.js';

// Sliders save after this pause, so dragging doesn't restyle the dock on
// every step.
const SCALE_UPDATE_TIMEOUT = 500;
const ICON_SIZE_MARKS = [128, 96, 64, 48, 32, 24, 16];

// [nick, label] pairs for the enum keys, in schema order. They are
// functions so the labels are translated when the pages are built.
const CLICK_ACTIONS = () => [
    ['skip', __('Focus the Window')],
    ['minimize', __('Focus or Minimise')],
    ['launch', __('Open a New Window')],
    ['cycle-windows', __('Cycle Through Windows')],
    ['minimize-or-overview', __('Minimise or Show in Overview')],
    ['previews', __('Show Window Previews')],
    ['minimize-or-previews', __('Minimise or Show Previews')],
    ['focus-or-previews', __('Focus or Show Previews')],
    ['focus-or-appspread', __('Focus or Spread Out Windows')],
    ['focus-minimize-or-previews', __('Focus, Minimise or Show Previews')],
    ['focus-minimize-or-appspread', __('Focus, Minimise or Spread Out Windows')],
    ['quit', __('Quit the App')],
];

const SCROLL_ACTIONS = () => [
    ['do-nothing', __('Do Nothing')],
    ['cycle-windows', __('Cycle Through Windows')],
    ['switch-workspace', __('Switch Workspace')],
];

const INTELLIHIDE_MODES = () => [
    ['ALL_WINDOWS', __('Any Window')],
    ['FOCUS_APPLICATION_WINDOWS', __('Windows of the Focused App')],
    ['MAXIMIZED_WINDOWS', __('Maximised Windows Only')],
    ['ALWAYS_ON_TOP', __('Never, Stay on Top')],
];

const TRANSPARENCY_MODES = () => [
    ['DEFAULT', __('Theme Default')],
    ['FIXED', __('Fixed')],
    ['DYNAMIC', __('Adaptive')],
];

const INDICATOR_STYLES = () => [
    ['DEFAULT', __('Theme Default')],
    ['DOTS', __('Dots')],
    ['SQUARES', __('Squares')],
    ['DASHES', __('Dashes')],
    ['SEGMENTED', __('Segmented Line')],
    ['SOLID', __('Solid Line')],
    ['CILIORA', __('Line and Dots')],
    ['METRO', __('Full-Width Bar')],
    ['BINARY', __('Binary Count')],
    ['DOT', __('Single Dot')],
];

const MonitorsConfig = GObject.registerClass({
    Signals: {
        'updated': {},
    },
}, class MonitorsConfig extends GObject.Object {
    static get XML_INTERFACE() {
        return '<node>\
            <interface name="org.gnome.Mutter.DisplayConfig">\
                <method name="GetCurrentState">\
                <arg name="serial" direction="out" type="u" />\
                <arg name="monitors" direction="out" type="a((ssss)a(siiddada{sv})a{sv})" />\
                <arg name="logical_monitors" direction="out" type="a(iiduba(ssss)a{sv})" />\
                <arg name="properties" direction="out" type="a{sv}" />\
                </method>\
                <signal name="MonitorsChanged" />\
            </interface>\
        </node>';
    }

    static get ProxyWrapper() {
        return Gio.DBusProxy.makeProxyWrapper(MonitorsConfig.XML_INTERFACE);
    }

    constructor() {
        super();

        this._monitorsConfigProxy = new MonitorsConfig.ProxyWrapper(
            Gio.DBus.session,
            'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig'
        );

        // Connecting to a D-Bus signal
        this._monitorsConfigProxy.connectSignal('MonitorsChanged',
            () => this._updateResources());

        this._primaryMonitor = null;
        this._monitors = [];
        this._logicalMonitors = [];

        this._updateResources();
    }

    _updateResources() {
        this._monitorsConfigProxy.GetCurrentStateRemote((resources, err) => {
            if (err) {
                logError(err);
                return;
            }

            const [serial_, monitors, logicalMonitors] = resources;
            this._monitors = [];
            let index = 0;
            for (const monitor of monitors) {
                const [monitorSpecs, modes_, props] = monitor;
                const [connector, vendor, product, serial] = monitorSpecs;
                this._monitors.push({
                    index: index++,
                    active: false,
                    connector, vendor, product, serial,
                    displayName: props['display-name'].unpack(),
                });
            }

            for (const logicalMonitor of logicalMonitors) {
                const [x_, y_, scale_, transform_, isPrimary, monitorsSpecs] =
                    logicalMonitor;

                // We only care about the first one really
                for (const monitorSpecs of monitorsSpecs) {
                    const [connector, vendor, product, serial] = monitorSpecs;
                    const monitor = this._monitors.find(m =>
                        m.connector === connector && m.vendor === vendor &&
                        m.product === product && m.serial === serial);

                    if (monitor) {
                        monitor.active = true;
                        monitor.isPrimary = isPrimary;
                        if (monitor.isPrimary)
                            this._primaryMonitor = monitor;
                        break;
                    }
                }
            }

            const activeMonitors = this._monitors.filter(m => m.active);
            if (activeMonitors.length > 1 && logicalMonitors.length === 1) {
                // We're in cloning mode, so let's just activate the primary monitor
                this._monitors.forEach(m => (m.active = false));
                this._primaryMonitor.active = true;
            }

            this._updateMonitorsIndexes();
            this.emit('updated');
        });
    }

    _updateMonitorsIndexes() {
        // The dock uses the old Gdk indexing, where the primary monitor is
        // always 0, as _createDocks in docking.js does
        const {index: primaryMonitorIndex} = this._primaryMonitor;
        for (const monitor of this._monitors) {
            let {index} = monitor;
            index -= primaryMonitorIndex;

            if (index < 0)
                index += this._monitors.length;

            monitor.index = index;
        }
    }

    get monitors() {
        return this._monitors;
    }
});

/**
 * Store the parsed form of shortcut-text in shortcut.
 *
 * @param {Gio.Settings} settings the extension settings
 */
function setShortcut(settings) {
    const shortcutText = settings.get_string('shortcut-text');
    const [success, key, mods] = Gtk.accelerator_parse(shortcutText);

    if (success && Gtk.accelerator_valid(key, mods)) {
        const shortcut = Gtk.accelerator_name(key, mods);
        settings.set_strv('shortcut', [shortcut]);
    } else {
        settings.set_strv('shortcut', []);
    }
}

/**
 * Settings shared by the dock pages, with helpers that make bound rows and
 * tidy up their signal handlers when the window closes.
 */
class DockPrefs {
    constructor(settings) {
        this.settings = settings;
        this._handlers = [];
        this._timeouts = new Map();
    }

    connect(object, signal, callback) {
        this._handlers.push([object, object.connect(signal, callback)]);
    }

    destroy() {
        this._handlers.forEach(([object, id]) => object.disconnect(id));
        this._handlers = [];
        this._timeouts.forEach(id => GLib.source_remove(id));
        this._timeouts.clear();
    }

    /** Run callback now and whenever any of keys changes. */
    watch(keys, callback) {
        callback();
        keys.forEach(key => this.connect(this.settings, `changed::${key}`, callback));
    }

    switchRow(key, title, subtitle = '', flags = Gio.SettingsBindFlags.DEFAULT) {
        const row = new Adw.SwitchRow({title, subtitle});
        this.settings.bind(key, row, 'active', flags);
        return row;
    }

    /** An expander row whose switch turns key on and off. */
    expanderRow(key, title, subtitle = '') {
        const row = new Adw.ExpanderRow({title, subtitle, show_enable_switch: true});
        this.settings.bind(key, row, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
        // Enabling expands the row, so collapse it again to keep the page short
        row.expanded = false;
        return row;
    }

    spinRow(key, title, subtitle, lower, upper, step, digits = 0) {
        const row = Adw.SpinRow.new_with_range(lower, upper, step);
        row.set({title, subtitle, digits});
        this.settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    /** A combo row for an enum key, given [nick, label] pairs. */
    choiceRow(key, title, subtitle, choices) {
        const row = new Adw.ComboRow({
            title,
            subtitle,
            model: Gtk.StringList.new(choices.map(([, label]) => label)),
        });
        bindChoice(this.settings, key, row, choices.map(([nick]) => nick));
        return row;
    }

    /**
     * A row with a slider for a number key. The value is saved after the
     * slider has been still for a moment.
     */
    scaleRow(key, title, subtitle, {lower, upper, step, format, marks = [], isInt = false}) {
        const row = new Adw.ActionRow({title, subtitle});
        const scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, lower, upper, step);
        scale.set({
            hexpand: true,
            valign: Gtk.Align.CENTER,
            draw_value: true,
            value_pos: Gtk.PositionType.RIGHT,
            width_request: 240,
        });
        scale.set_format_value_func((_, value) => format(value));
        marks.forEach(mark => scale.add_mark(mark, Gtk.PositionType.BOTTOM, null));

        const get = () => isInt ? this.settings.get_int(key) : this.settings.get_double(key);
        let syncing = false;
        this.watch([key], () => {
            if (Math.abs(scale.get_value() - get()) < step / 2)
                return;
            syncing = true;
            scale.set_value(get());
            syncing = false;
        });
        scale.connect('value-changed', () => {
            if (syncing)
                return;
            if (this._timeouts.has(key))
                GLib.source_remove(this._timeouts.get(key));
            this._timeouts.set(key, GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                SCALE_UPDATE_TIMEOUT, () => {
                    this._timeouts.delete(key);
                    const value = scale.get_value();
                    if (isInt)
                        this.settings.set_int(key, Math.round(value));
                    else
                        this.settings.set_double(key, value);
                    return GLib.SOURCE_REMOVE;
                }));
        });
        row.add_suffix(scale);
        return row;
    }

    /** A colour button for a string key holding a CSS colour. */
    colourButton(key, title) {
        const button = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({title, with_alpha: false}),
            valign: Gtk.Align.CENTER,
        });
        this.watch([key], () => {
            const rgba = new Gdk.RGBA();
            if (rgba.parse(this.settings.get_string(key)) && !rgba.equal(button.rgba))
                button.rgba = rgba;
        });
        button.connect('notify::rgba', () => {
            const css = button.rgba.to_string();
            if (css !== this.settings.get_string(key))
                this.settings.set_string(key, css);
        });
        return button;
    }

    colourRow(key, title, subtitle = '') {
        const row = new Adw.ActionRow({title, subtitle});
        const button = this.colourButton(key, title);
        row.add_suffix(button);
        row.activatable_widget = button;
        return row;
    }

    /** Make widget sensitive only while key is true (or false, if inverted). */
    sensitiveWhen(key, widget, invert = false) {
        let flags = Gio.SettingsBindFlags.GET;
        if (invert)
            flags |= Gio.SettingsBindFlags.INVERT_BOOLEAN;
        this.settings.bind(key, widget, 'sensitive', flags);
    }

    /** Show widget only while test() is true, rechecking when keys change. */
    visibleWhen(keys, widget, test) {
        this.watch(keys, () => (widget.visible = test()));
    }
}

const PositionPage = GObject.registerClass(
class PositionPage extends Adw.PreferencesPage {
    constructor(prefs) {
        super({
            name: 'position',
            title: __('Position'),
            icon_name: 'preferences-desktop-display-symbolic',
        });
        this._prefs = prefs;
        this._settings = prefs.settings;

        this._addPlacementGroup();
        this._addSizeGroup();
        this._addVisibilityGroup();
    }

    _addPlacementGroup() {
        const prefs = this._prefs;
        const group = new Adw.PreferencesGroup({title: __('Placement')});

        // The setting stores the side as it would be in a left-to-right
        // layout, so swap the labels in right-to-left languages.
        const rtl = Gtk.Widget.get_default_direction() === Gtk.TextDirection.RTL;
        const sides = new Adw.ToggleGroup({valign: Gtk.Align.CENTER});
        [
            ['LEFT', rtl ? __('Right') : __('Left')],
            ['BOTTOM', __('Bottom')],
            ['TOP', __('Top')],
            ['RIGHT', rtl ? __('Left') : __('Right')],
        ].forEach(([name, label]) => sides.add(new Adw.Toggle({name, label})));
        this._settings.bind('dock-position', sides, 'active-name',
            Gio.SettingsBindFlags.DEFAULT);
        const position = new Adw.ActionRow({title: __('Screen Edge')});
        position.add_suffix(sides);
        group.add(position);

        group.add(prefs.switchRow('multi-monitor', __('Show on All Monitors')));

        this._monitorRow = new Adw.ComboRow({
            title: __('Monitor'),
            subtitle: __('The monitor the dock appears on'),
        });
        prefs.sensitiveWhen('multi-monitor', this._monitorRow, true);
        this._monitorsConfig = new MonitorsConfig();
        prefs.connect(this._monitorsConfig, 'updated', () => this._updateMonitors());
        prefs.watch(['preferred-monitor', 'preferred-monitor-by-connector'],
            () => this._updateMonitors());
        this._monitorRow.connect('notify::selected', () => {
            const monitor = this._monitors?.[this._monitorRow.selected];
            if (!monitor || this._updatingMonitors)
                return;
            this._updatingMonitors = true;
            this._settings.set_string('preferred-monitor-by-connector', monitor.connector);
            this._settings.set_int('preferred-monitor', -2);
            this._updatingMonitors = false;
        });
        group.add(this._monitorRow);

        this.add(group);
    }

    _updateMonitors() {
        if (this._updatingMonitors)
            return;

        const preferred = this._settings.get_int('preferred-monitor');
        const preferredConnector = this._settings.get_string('preferred-monitor-by-connector');
        this._monitors = this._monitorsConfig.monitors.filter(m =>
            m.active || m.index === preferred);

        const labels = this._monitors.map(m => m.isPrimary
            /* Translators: followed by the monitor's name and connector */
            ? `${__('Primary')}: ${m.displayName} (${m.connector})`
            : `${m.displayName} (${m.connector})`);
        let selected = this._monitors.findIndex(m => m.index === preferred ||
            (preferred === -2 && m.connector === preferredConnector));
        if (selected < 0)
            selected = Math.max(0, this._monitors.findIndex(m => m.isPrimary));

        this._updatingMonitors = true;
        this._monitorRow.model = Gtk.StringList.new(labels);
        this._monitorRow.selected = selected;
        this._updatingMonitors = false;
    }

    _addSizeGroup() {
        const prefs = this._prefs;
        const group = new Adw.PreferencesGroup({title: __('Size')});

        group.add(prefs.scaleRow('dash-max-icon-size', __('Icon Size'),
            __('The largest the icons can be. They shrink to fit when the dock is full.'), {
                lower: 16, upper: 128, step: 1, isInt: true,
                format: v => `${v} px`, marks: ICON_SIZE_MARKS,
            }));

        const fixed = prefs.switchRow('icon-size-fixed', __('Keep Icons at Full Size'),
            __('Scroll the dock to reach icons that do not fit, instead of shrinking them'));
        group.add(fixed);

        const length = prefs.scaleRow('height-fraction', __('Maximum Length'),
            __('How much of the screen edge the dock may use'), {
                lower: 0.33, upper: 1, step: 0.01,
                format: v => `${Math.round(v * 100)}%`, marks: [0.9],
            });
        prefs.sensitiveWhen('extend-height', length, true);
        group.add(length);

        const extend = prefs.expanderRow('extend-height', __('Stretch to Fill the Edge'),
            __('The dock runs the full length of the screen edge, like a panel'));
        extend.add_row(prefs.switchRow('always-center-icons', __('Centre the Icons'),
            __('Keep the icons in the middle of the screen rather than at the start')));
        const showAppsEdge = prefs.switchRow('show-apps-always-in-the-edge',
            __('Show Apps Button at the Edge'),
            __('Keep the Show Apps button at the end of the dock when the icons are centred'));
        prefs.sensitiveWhen('show-show-apps-button', showAppsEdge);
        extend.add_row(showAppsEdge);
        group.add(extend);

        this.add(group);
    }

    _addVisibilityGroup() {
        const prefs = this._prefs;
        const group = new Adw.PreferencesGroup({
            title: __('Visibility'),
            description:
                __('When the dock hides, it comes back when ' +
                    'you move the pointer to its edge of the screen.'),
        });

        const alwaysVisible = prefs.switchRow('dock-fixed', __('Always Visible'),
            __('Keep the dock on screen and fit windows around it. Turn off to let the dock hide.'));
        group.add(alwaysVisible);

        const dodge = prefs.expanderRow('intellihide', __('Hide When Windows Overlap'),
            __('The dock steps aside when a window would cover it'));
        dodge.add_row(prefs.choiceRow('intellihide-mode', __('Windows That Hide the Dock'),
            '', INTELLIHIDE_MODES()));
        prefs.sensitiveWhen('dock-fixed', dodge, true);
        group.add(dodge);

        const autohide = prefs.expanderRow('autohide', __('Show When Pointer Reaches the Edge'),
            __('Reveal the hidden dock by moving the pointer to the screen edge'));
        const pressure = prefs.switchRow('require-pressure-to-show', __('Push to Reveal'),
            __('Only show the dock when you push the pointer ' +
                'against the edge, to avoid showing it by accident'));
        autohide.add_row(pressure);
        const threshold = prefs.spinRow('pressure-threshold', __('Push Strength'),
            __('How hard you need to push, in pixels of pointer movement'), 0, 500, 5);
        prefs.sensitiveWhen('require-pressure-to-show', threshold);
        autohide.add_row(threshold);
        const showDelay = prefs.spinRow('show-delay', __('Show Delay'),
            __('Seconds to wait at the edge before the dock appears'), 0, 1, 0.05, 2);
        prefs.sensitiveWhen('require-pressure-to-show', showDelay, true);
        autohide.add_row(showDelay);
        autohide.add_row(prefs.switchRow('autohide-in-fullscreen', __('Also in Full-Screen Apps'),
            __('Allow the dock to appear over full-screen windows')));
        autohide.add_row(prefs.switchRow('show-dock-urgent-notify',
            __('Show for Apps That Need Attention'),
            __('Briefly show the dock when an app asks for your attention')));
        prefs.sensitiveWhen('dock-fixed', autohide, true);
        group.add(autohide);

        const hideDelay = prefs.spinRow('hide-delay', __('Hide Delay'),
            __('Seconds to wait after the pointer leaves before the dock hides'), 0, 1, 0.05, 2);
        prefs.sensitiveWhen('dock-fixed', hideDelay, true);
        group.add(hideDelay);

        const animation = prefs.spinRow('animation-time', __('Animation Duration'),
            __('Seconds the dock takes to slide in and out'), 0, 1, 0.05, 2);
        prefs.sensitiveWhen('dock-fixed', animation, true);
        group.add(animation);

        this.add(group);
    }
});

const BehaviourPage = GObject.registerClass(
class BehaviourPage extends Adw.PreferencesPage {
    constructor(prefs) {
        super({
            name: 'behaviour',
            title: __('Behaviour'),
            icon_name: 'input-mouse-symbolic',
        });
        this._prefs = prefs;
        this._settings = prefs.settings;

        this._addExtrasGroup();
        this._addContentsGroup();
        this._addFilteringGroup();
        this._addClickGroup();
        this._addPreviewsGroup();
        this._addIconsGroup();
        this._addKeyboardGroup();
        this._addStartupGroup();
    }

    _addExtrasGroup() {
        const prefs = this._prefs;
        const group = new Adw.PreferencesGroup({
            title: __('StackDock Extras'),
            description: __('Optional features added by StackDock.'),
        });

        const hover = prefs.expanderRow('hover-previews', __('Previews on Hover'),
            __('Show an app\'s windows when the pointer rests on its icon'));
        hover.add_row(prefs.spinRow('hover-previews-delay', __('Delay'),
            __('Milliseconds to wait before the previews appear'), 0, 2000, 50));
        group.add(hover);

        group.add(prefs.switchRow('bounce-launching-applications', __('Bounce While Launching'),
            __('Bounce an app\'s icon while it starts, until its window appears')));

        const panel = prefs.switchRow('panel-match-dock', __('Match the Top Bar'),
            __('Give the top bar the same colour and opacity as the dock'));
        prefs.sensitiveWhen('apply-custom-theme', panel, true);
        group.add(panel);

        this.add(group);
    }

    _addContentsGroup() {
        const prefs = this._prefs;
        const group = new Adw.PreferencesGroup({title: __('Dock Contents')});

        group.add(prefs.switchRow('show-favorites', __('Pinned Apps')));
        group.add(prefs.switchRow('show-running', __('Running Apps'),
            __('Apps that are open but not pinned')));
        group.add(prefs.switchRow('show-trash', __('Trash')));

        const showApps = prefs.expanderRow('show-show-apps-button', __('Show Apps Button'),
            __('Opens the app grid'));
        showApps.add_row(prefs.switchRow('show-apps-at-top', __('Place at the Start'),
            __('Put the button before the apps instead of after them')));
        group.add(showApps);

        this.add(group);
    }

    _addFilteringGroup() {
        const prefs = this._prefs;
        const group = new Adw.PreferencesGroup({
            title: __('Workspaces and Monitors'),
        });

        // Unless set here, this follows GNOME's own Multitasking setting
        const appSwitcher = new Gio.Settings({schema_id: 'org.gnome.shell.app-switcher'});
        const isolation = new Adw.SwitchRow({
            title: __('Only Apps on the Current Workspace'),
        });
        const hasOverride = () =>
            this._settings.get_user_value('isolate-workspaces') !== null;
        const gnomeIsolation = () => appSwitcher.get_boolean('current-workspace-only');
        let updating = false;
        const update = () => {
            updating = true;
            isolation.active = hasOverride()
                ? this._settings.get_boolean('isolate-workspaces') : gnomeIsolation();
            isolation.subtitle = hasOverride()
                ? __('Show running apps only on the workspace they are on')
                : __('Follows the Multitasking setting in GNOME Settings');
            updating = false;
        };
        isolation.connect('notify::active', () => {
            if (updating)
                return;
            if (isolation.active === gnomeIsolation())
                this._settings.reset('isolate-workspaces');
            else
                this._settings.set_boolean('isolate-workspaces', isolation.active);
        });
        prefs.watch(['isolate-workspaces'], update);
        prefs.connect(appSwitcher, 'changed::current-workspace-only', update);
        group.add(isolation);

        group.add(prefs.switchRow('workspace-agnostic-urgent-windows',
            __('Show Apps Needing Attention Everywhere'),
            __('Apps asking for attention appear on every workspace')));

        group.add(prefs.switchRow('isolate-monitors', __('Only Apps on the Same Monitor'),
            __('With a dock on each monitor, each shows only the apps on its monitor')));

        const locations = prefs.switchRow('isolate-locations',
            __('Separate Trash and Drive Windows'),
            __('Treat Files windows showing the trash or a drive as their own icons'));
        prefs.visibleWhen(['show-trash', 'show-mounts', 'stack-drives'], locations, () =>
            this._settings.get_boolean('show-trash') ||
            (this._settings.get_boolean('show-mounts') && !this._settings.get_boolean('stack-drives')));
        group.add(locations);

        this.add(group);
    }

    _addClickGroup() {
        const prefs = this._prefs;
        const group = new Adw.PreferencesGroup({
            title: __('Clicking and Scrolling'),
            description: __('What happens when you click an app that is already open.'),
        });

        // "Quit" is only offered for the modified clicks, so a plain click
        // can never close an app by accident.
        group.add(prefs.choiceRow('click-action', __('Click'), '',
            CLICK_ACTIONS().slice(0, -1)));

        const more = new Adw.ExpanderRow({
            title: __('Other Clicks'),
            subtitle: __('Shift+click, middle-click and Shift+middle-click'),
        });
        more.add_row(prefs.choiceRow('shift-click-action', __('Shift+Click'), '', CLICK_ACTIONS()));
        more.add_row(prefs.choiceRow('middle-click-action', __('Middle-Click'), '', CLICK_ACTIONS()));
        more.add_row(prefs.choiceRow('shift-middle-click-action', __('Shift+Middle-Click'), '',
            CLICK_ACTIONS()));
        group.add(more);

        const scroll = prefs.choiceRow('scroll-action', __('Scroll'), '', SCROLL_ACTIONS());
        prefs.watch(['icon-size-fixed'], () => {
            scroll.subtitle = this._settings.get_boolean('icon-size-fixed')
                ? __('Only works between icons, because Keep Icons at Full Size scrolls the dock')
                : __('Scrolling over an app\'s icon');
        });
        group.add(scroll);

        this.add(group);
    }

    _addPreviewsGroup() {
        const prefs = this._prefs;
        const group = new Adw.PreferencesGroup({title: __('Window Previews')});

        group.add(prefs.switchRow('show-windows-preview', __('Previews in App Menus'),
            __('Show pictures of the open windows instead of a list of their names')));

        group.add(prefs.scaleRow('preview-size-scale', __('Preview Size'),
            __('Leave at Automatic to fit the screen'), {
                lower: 0, upper: 1, step: 0.01,
                format: v => v === 0 ? __('Automatic') : `${Math.round(v * 100)}%`,
            }));

        this.add(group);
    }

    _addIconsGroup() {
        const prefs = this._prefs;
        const group = new Adw.PreferencesGroup({title: __('Icons')});

        group.add(prefs.switchRow('dance-urgent-applications', __('Wiggle Apps Needing Attention')));
        group.add(prefs.switchRow('hide-tooltip', __('Hide Name Tooltips'),
            __('Don\'t show the app\'s name when the pointer rests on its icon')));
        group.add(prefs.switchRow('scroll-to-focused-application', __('Keep the Focused App in View'),
            __('Scroll the dock so the icon of the focused app is always visible')));

        const badges = prefs.expanderRow('show-icons-emblems', __('Badges'),
            __('Counters and progress bars on app icons'));
        const notifications = prefs.switchRow('show-icons-notifications-counter',
            __('Unread Notification Count'));
        badges.add_row(notifications);
        const override = prefs.switchRow('application-counter-overrides-notifications',
            __('Prefer the App\'s Own Count'),
            __('Apps that set their own badge show it instead of the notification count'));
        prefs.sensitiveWhen('show-icons-notifications-counter', override);
        badges.add_row(override);
        group.add(badges);

        this.add(group);
    }

    _addKeyboardGroup() {
        const prefs = this._prefs;
        const group = new Adw.PreferencesGroup({title: __('Keyboard')});

        const hotKeys = prefs.expanderRow('hot-keys', __('Open Apps with Super+Number'),
            __('Super+1 to Super+0 open the first ten apps. Add Shift or Ctrl for more actions.'));
        hotKeys.add_row(prefs.switchRow('hotkeys-overlay', __('Show Numbers on Icons'),
            __('Show each app\'s number while the shortcut below is held')));
        hotKeys.add_row(prefs.switchRow('hotkeys-show-dock', __('Show the Dock'),
            __('Briefly show a hidden dock when the shortcut below is pressed')));

        const shortcut = new Adw.EntryRow({
            title: __('Shortcut to Show Numbers'),
            show_apply_button: true,
        });
        shortcut.text = this._settings.get_string('shortcut-text');
        shortcut.connect('apply', () => {
            this._settings.set_string('shortcut-text', shortcut.text);
            setShortcut(this._settings);
        });
        const hint = new Gtk.Label({
            label: __('For example &lt;Super&gt;q'),
            use_markup: true,
            css_classes: ['dim-label'],
        });
        shortcut.add_suffix(hint);
        hotKeys.add_row(shortcut);

        hotKeys.add_row(prefs.spinRow('shortcut-timeout', __('Numbers Stay For'),
            __('Seconds the numbers and dock stay visible'), 0, 10, 0.25, 2));
        group.add(hotKeys);

        this.add(group);
    }

    _addStartupGroup() {
        const group = new Adw.PreferencesGroup({title: __('Startup')});
        group.add(this._prefs.switchRow('disable-overview-on-startup',
            __('Show the Overview at Login'),
            __('Open Activities when you log in, as GNOME does by default'),
            Gio.SettingsBindFlags.INVERT_BOOLEAN));
        this.add(group);
    }
});

const AppearancePage = GObject.registerClass(
class AppearancePage extends Adw.PreferencesPage {
    constructor(prefs) {
        super({
            name: 'appearance',
            title: __('Appearance'),
            icon_name: 'preferences-desktop-appearance-symbolic',
        });
        this._prefs = prefs;
        this._settings = prefs.settings;

        this._addStyleGroup();
        this._addBackgroundGroup();
        this._addIndicatorsGroup();
    }

    _addStyleGroup() {
        const prefs = this._prefs;
        const group = new Adw.PreferencesGroup({title: __('Style')});

        group.add(prefs.switchRow('apply-custom-theme', __('Use the Built-in Style'),
            __('A ready-made look that suits the default GNOME theme. Turn ' +
                'off to choose the colours, opacity and indicators yourself.')));
        group.add(prefs.switchRow('custom-theme-shrink', __('Compact'),
            __('Less padding and smaller rounded corners')));
        group.add(prefs.switchRow('force-straight-corner', __('Square Corners')));

        const backlit = prefs.expanderRow('unity-backlit-items', __('Coloured Icon Backgrounds'),
            __('Light each running app with its icon\'s main colour, as Unity did'));
        backlit.add_row(prefs.switchRow('apply-glossy-effect', __('Glossy Finish')));
        group.add(backlit);

        this.add(group);
    }

    _addBackgroundGroup() {
        const prefs = this._prefs;
        const group = new Adw.PreferencesGroup({title: __('Background')});
        prefs.sensitiveWhen('apply-custom-theme', group, true);

        const colour = new Adw.ActionRow({
            title: __('Custom Colour'),
            subtitle: __('Use your own background colour instead of the theme\'s'),
        });
        const colourButton = prefs.colourButton('background-color', __('Dock Colour'));
        prefs.sensitiveWhen('custom-background-color', colourButton);
        const colourSwitch = new Gtk.Switch({valign: Gtk.Align.CENTER});
        this._settings.bind('custom-background-color', colourSwitch, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        colour.add_suffix(colourButton);
        colour.add_suffix(colourSwitch);
        colour.activatable_widget = colourSwitch;
        group.add(colour);

        group.add(prefs.choiceRow('transparency-mode', __('Opacity'),
            __('Adaptive makes the dock more solid when a window is next to it'),
            TRANSPARENCY_MODES()));

        const mode = () => this._settings.get_string('transparency-mode');

        const opacity = prefs.scaleRow('background-opacity', __('Fixed Opacity'), '', {
            lower: 0, upper: 1, step: 0.01, format: v => `${Math.round(v * 100)}%`,
        });
        prefs.visibleWhen(['transparency-mode'], opacity, () => mode() === 'FIXED');
        group.add(opacity);

        const range = prefs.expanderRow('customize-alphas', __('Custom Adaptive Range'),
            __('Choose how see-through the dock is with and without a window next to it'));
        range.add_row(prefs.scaleRow('min-alpha', __('No Window Nearby'), '', {
            lower: 0, upper: 1, step: 0.01, format: v => `${Math.round(v * 100)}%`,
        }));
        range.add_row(prefs.scaleRow('max-alpha', __('Window Nearby'), '', {
            lower: 0, upper: 1, step: 0.01, format: v => `${Math.round(v * 100)}%`,
        }));
        prefs.visibleWhen(['transparency-mode'], range, () => mode() === 'DYNAMIC');
        group.add(range);

        this.add(group);
    }

    _addIndicatorsGroup() {
        const prefs = this._prefs;
        const group = new Adw.PreferencesGroup({
            title: __('Running App Indicators'),
            description: __('The marks under the icons of open apps. Most styles show one mark per window.'),
        });
        prefs.sensitiveWhen('apply-custom-theme', group, true);

        group.add(prefs.choiceRow('running-indicator-style', __('Style'), '', INDICATOR_STYLES()));

        const custom = () => this._settings.get_string('running-indicator-style') !== 'DEFAULT';

        const dominant = prefs.switchRow('running-indicator-dominant-color',
            __('Match Each App\'s Icon'), __('Colour the indicators with the icon\'s main colour'));
        prefs.visibleWhen(['running-indicator-style'], dominant, custom);
        group.add(dominant);

        const colours = prefs.expanderRow('custom-theme-customize-running-dots',
            __('Custom Colours'), __('Use the same colours for every app'));
        colours.add_row(prefs.colourRow('custom-theme-running-dots-color', __('Colour')));
        colours.add_row(prefs.colourRow('custom-theme-running-dots-border-color',
            __('Border Colour')));
        colours.add_row(prefs.spinRow('custom-theme-running-dots-border-width',
            __('Border Width'), __('In pixels'), 0, 10, 1));
        prefs.visibleWhen(['running-indicator-style'], colours, custom);
        group.add(colours);

        this.add(group);
    }
});

/**
 * Create the dock pages.
 *
 * @param {Gio.Settings} settings the extension settings
 * @returns {{pages: Adw.PreferencesPage[], destroy: Function}}
 */
export function createDockPages(settings) {
    const prefs = new DockPrefs(settings);
    return {
        pages: [
            new PositionPage(prefs),
            new BehaviourPage(prefs),
            new AppearancePage(prefs),
        ],
        destroy: () => prefs.destroy(),
    };
}
