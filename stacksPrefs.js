// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

// The "Stacks" page of the preferences window.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {
    gettext as __,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const VIEWS = ['auto', 'fan', 'grid'];
const SORTS = ['modified', 'name', 'kind'];

/**
 * Bind a combo row to a string setting with a fixed list of values.
 *
 * @param {Gio.Settings} settings the settings holding the key
 * @param {string} key the string key
 * @param {Adw.ComboRow} row the row to bind
 * @param {string[]} values the setting value of each row choice, in order
 */
function bindChoice(settings, key, row, values) {
    const sync = () => {
        row.selected = Math.max(0, values.indexOf(settings.get_string(key)));
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => {
        const value = values[row.selected];
        if (value && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
}

function appFolderName(folderId) {
    const settings = new Gio.Settings({
        schema_id: 'org.gnome.desktop.app-folders.folder',
        path: `/org/gnome/desktop/app-folders/folders/${folderId}/`,
    });
    const name = settings.get_string('name');
    if (!settings.get_boolean('translate'))
        return name || folderId;
    try {
        const keyFile = new GLib.KeyFile();
        keyFile.load_from_data_dirs(`desktop-directories/${name}`, GLib.KeyFileFlags.NONE);
        return keyFile.get_locale_string('Desktop Entry', 'Name', null) || name;
    } catch {
        return name || folderId;
    }
}

function displayPath(path) {
    const home = GLib.get_home_dir();
    return path === home || path.startsWith(`${home}/`)
        ? `~${path.slice(home.length)}` : path;
}

/** A group whose rows are rebuilt from scratch when its data changes. */
function rebuildRows(group, rows, makeRows) {
    rows.forEach(row => group.remove(row));
    rows.length = 0;
    for (const row of makeRows()) {
        group.add(row);
        rows.push(row);
    }
}

function placeholderRow(text) {
    const row = new Adw.ActionRow({title: text, activatable: false});
    row.add_css_class('dim-label');
    return row;
}

export const StacksPage = GObject.registerClass(
class StacksPage extends Adw.PreferencesPage {
    constructor(settings) {
        super({
            name: 'stacks',
            title: __('Stacks'),
            icon_name: 'folder-symbolic',
        });
        this._settings = settings;
        this._appFolders = new Gio.Settings({schema_id: 'org.gnome.desktop.app-folders'});

        this._addBehaviourGroup();
        this._addFoldersGroup();
        this._addAppFoldersGroup();
        this._addDrivesGroup();
    }

    _addBehaviourGroup() {
        const group = new Adw.PreferencesGroup({
            title: __('Opening Stacks'),
            description: __('Small stacks fan out from the dock; bigger ones open as a grid you can search. Right-click a stack in the dock for the same options.'),
        });

        const view = new Adw.ComboRow({
            title: __('View As'),
            model: Gtk.StringList.new([__('Automatic'), __('Fan'), __('Grid')]),
        });
        bindChoice(this._settings, 'stack-view', view, VIEWS);
        group.add(view);

        const fanMax = Adw.SpinRow.new_with_range(4, 16, 1);
        fanMax.set({
            title: __('Largest Fan'),
            subtitle: __('In automatic view, stacks with more items open as a grid'),
        });
        this._settings.bind('stack-fan-max', fanMax, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(fanMax);

        const sort = new Adw.ComboRow({
            title: __('Sort Files By'),
            model: Gtk.StringList.new([__('Date Modified'), __('Name'), __('Kind')]),
        });
        bindChoice(this._settings, 'stack-sort', sort, SORTS);
        group.add(sort);

        this.add(group);
    }

    _addFoldersGroup() {
        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: __('Add Folder…'),
            valign: Gtk.Align.CENTER,
        });
        addButton.add_css_class('flat');
        addButton.connect('clicked', () => this._chooseFolder());

        const group = new Adw.PreferencesGroup({
            title: __('Folder Stacks'),
            description: __('Folders shown near the end of the dock, such as Downloads or Documents.'),
            header_suffix: addButton,
        });

        const rows = [];
        const rebuild = () => rebuildRows(group, rows, () => {
            const folders = this._settings.get_strv('stack-folders');
            if (!folders.length)
                return [placeholderRow(__('No folders yet. Press + to add one.'))];
            return folders.map(path => this._folderRow(path));
        });
        this._settings.connect('changed::stack-folders', rebuild);
        rebuild();

        this.add(group);
    }

    _folderRow(path) {
        const row = new Adw.ActionRow({
            title: GLib.markup_escape_text(GLib.filename_display_basename(path), -1),
            subtitle: GLib.markup_escape_text(displayPath(path), -1),
        });
        row.add_prefix(new Gtk.Image({icon_name: 'folder-symbolic'}));

        const remove = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            tooltip_text: __('Remove from Dock'),
            valign: Gtk.Align.CENTER,
        });
        remove.add_css_class('flat');
        remove.connect('clicked', () => {
            this._settings.set_strv('stack-folders',
                this._settings.get_strv('stack-folders').filter(p => p !== path));
        });
        row.add_suffix(remove);
        return row;
    }

    _chooseFolder() {
        const dialog = new Gtk.FileDialog({
            title: __('Add a Folder Stack'),
            accept_label: __('Add'),
            modal: true,
        });
        dialog.select_folder(this.get_root(), null, (_dialog, res) => {
            let folder;
            try {
                folder = dialog.select_folder_finish(res);
            } catch {
                return; // Cancelled
            }
            const path = folder?.get_path();
            const folders = this._settings.get_strv('stack-folders');
            if (path && !folders.includes(path))
                this._settings.set_strv('stack-folders', [...folders, path]);
        });
    }

    _addAppFoldersGroup() {
        const group = new Adw.PreferencesGroup({
            title: __('App Folder Stacks'),
            description: __('App grid folders shown right after your pinned apps. To make a folder, open Activities and drag one app onto another.'),
        });

        const rows = [];
        const rebuild = () => rebuildRows(group, rows, () => {
            const folders = this._appFolders.get_strv('folder-children');
            if (!folders.length)
                return [placeholderRow(__('You have no app folders yet.'))];
            const pinned = this._settings.get_strv('stack-app-folders');
            return folders.map(id => {
                const row = new Adw.SwitchRow({
                    title: GLib.markup_escape_text(appFolderName(id), -1),
                    active: pinned.includes(id),
                });
                row.connect('notify::active', () => {
                    const current = this._settings.get_strv('stack-app-folders');
                    if (row.active && !current.includes(id))
                        this._settings.set_strv('stack-app-folders', [...current, id]);
                    else if (!row.active && current.includes(id))
                        this._settings.set_strv('stack-app-folders', current.filter(f => f !== id));
                });
                return row;
            });
        });
        this._settings.connect('changed::stack-app-folders', rebuild);
        this._appFolders.connect('changed::folder-children', rebuild);
        rebuild();

        this.add(group);
    }

    _addDrivesGroup() {
        const group = new Adw.PreferencesGroup({title: __('Drives')});

        const showDrives = new Adw.SwitchRow({
            title: __('Show Drives in the Dock'),
            subtitle: __('USB drives, memory cards, and other mounted volumes'),
        });
        this._settings.bind('show-mounts', showDrives, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(showDrives);

        const stackDrives = new Adw.SwitchRow({
            title: __('Group Drives into a Stack'),
            subtitle: __('Show all drives as one Drives stack instead of separate icons'),
        });
        this._settings.bind('stack-drives', stackDrives, 'active', Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('show-mounts', stackDrives, 'sensitive', Gio.SettingsBindFlags.GET);
        group.add(stackDrives);

        this.add(group);
    }
});
