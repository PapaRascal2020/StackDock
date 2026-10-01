// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

// Stacks: dock items that open a fan or grid of files, apps or drives.
//
// Parts:
// - Stack sources (a folder, a GNOME app-grid folder, or the mounted drives)
//   say what a stack shows.
// - StackManager turns the settings into the list of sources the dock shows.
// - StackIcon is the dock button. StackFan and StackGrid are its popups.
//
// Contains code adapted from Dock Stacks by dragosol (GPL-2.0-or-later).

import {
    Clutter,
    Gio,
    GLib,
    GObject,
    Pango,
    Shell,
    St,
} from './dependencies/gi.js';

import {
    AppFavorites,
    BoxPointer,
    Dash,
    DND,
    IconGrid,
    Main,
    PopupMenu,
} from './dependencies/shell/ui.js';

import {Extension} from './dependencies/shell/extensions/extension.js';

import {
    Docking,
    Utils,
} from './imports.js';

const {gettext: __, ngettext} = Extension;

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'trash_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');
Gio._promisify(Gio.DBusConnection.prototype, 'call');

const FILE_ATTRIBUTES = [
    'standard::name',
    'standard::display-name',
    'standard::is-hidden',
    'standard::is-backup',
    'standard::icon',
    'standard::content-type',
    'standard::type',
    'time::modified',
    'thumbnail::path',
    'thumbnail::is-valid',
].join(',');

// Folders can be huge; enumerate this many at most, and show fewer
const MAX_ENUMERATED = 5000;
const MAX_SHOWN = 500;

// Wait for a burst of file changes to settle before finding the newest file
const NEWEST_FILE_REFRESH_DELAY = 500;
// Unfinished downloads, which should not become the stack's icon
const PARTIAL_DOWNLOAD_SUFFIXES = ['.part', '.crdownload', '.download', '.partial'];

const FAN_ICON_SIZE = 36;
// Space between a fan card's edge and its icon: padding plus border
const FAN_CARD_INSET = 6;
const FAN_PITCH = FAN_ICON_SIZE + 2 * FAN_CARD_INSET + 8;
const GRID_ICON_SIZE = 64;
const GRID_CELL_WIDTH = 96;
const GRID_CELL_HEIGHT = 112;
const GRID_SPACING = 8;
const GRID_PADDING = 12;
const GRID_SEARCH_MIN_ITEMS = 9;

// Distance between the dock edge and a popup
const POPUP_GAP = 10;
// Distance kept from the edges of the work area
const SCREEN_MARGIN = 8;
const ARROW_LENGTH = 24;
const ARROW_DEPTH = 11;

// St.ButtonMask.ONE and THREE are deprecated in Gnome Shell 51, but their new
// names may be missing in older versions
const PRIMARY_BUTTON = St.ButtonMask.PRIMARY ?? St.ButtonMask.ONE;
const SECONDARY_BUTTON = St.ButtonMask.SECONDARY ?? St.ButtonMask.THREE;

const DRAG_THRESHOLD = 12;
const OPEN_TIME = 180;
const CLOSE_TIME = 120;

const SPECIAL_FOLDER_ICONS = [
    [GLib.UserDirectory.DIRECTORY_DOWNLOAD, 'folder-download'],
    [GLib.UserDirectory.DIRECTORY_DOCUMENTS, 'folder-documents'],
    [GLib.UserDirectory.DIRECTORY_MUSIC, 'folder-music'],
    [GLib.UserDirectory.DIRECTORY_PICTURES, 'folder-pictures'],
    [GLib.UserDirectory.DIRECTORY_VIDEOS, 'folder-videos'],
    [GLib.UserDirectory.DIRECTORY_DESKTOP, 'user-desktop'],
    [GLib.UserDirectory.DIRECTORY_TEMPLATES, 'folder-templates'],
    [GLib.UserDirectory.DIRECTORY_PUBLIC_SHARE, 'folder-publicshare'],
];

const DOCK_STACKS_SCHEMA = 'org.gnome.shell.extensions.dock-stacks';
const DOCK_STACKS_UUID = 'dock-stacks@dragosr';

// ─── Stack items ────────────────────────────────────────────────────────────
//
// An item is a plain object:
//   name         shown under or beside the icon
//   gicon        its icon
//   isThumbnail  gicon is a picture of the file, so frame it
//   file, uri    for files
//   isDirectory  for sub-folders
//   app          for apps and drives (drives are Shell.Apps made by locations.js)
//   isDrive      for drives

function folderIconName(file) {
    for (const [dir, iconName] of SPECIAL_FOLDER_ICONS) {
        const path = GLib.get_user_special_dir(dir);
        if (path && file.equal(Gio.File.new_for_path(path)))
            return iconName;
    }
    if (file.equal(Gio.File.new_for_path(GLib.get_home_dir())))
        return 'user-home';
    return 'folder';
}

function fileItem(dir, info) {
    const file = dir.get_child(info.get_name());
    const contentType = info.get_content_type();
    let gicon = info.get_icon();
    let isThumbnail = false;

    const thumbnailPath = info.get_attribute_byte_string('thumbnail::path');
    const thumbnailValid = !info.has_attribute('thumbnail::is-valid') ||
        info.get_attribute_boolean('thumbnail::is-valid');
    if (thumbnailPath && thumbnailValid) {
        gicon = new Gio.FileIcon({file: Gio.File.new_for_path(thumbnailPath)});
        isThumbnail = true;
    } else if (contentType?.startsWith('image/')) {
        gicon = new Gio.FileIcon({file});
        isThumbnail = true;
    }

    return {
        name: info.get_display_name(),
        gicon: gicon ?? new Gio.ThemedIcon({name: 'text-x-generic'}),
        isThumbnail,
        file,
        uri: file.get_uri(),
        contentType,
        isDirectory: info.get_file_type() === Gio.FileType.DIRECTORY,
        modified: info.get_attribute_uint64('time::modified'),
    };
}

const collator = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});

function sortFileItems(items, sortBy) {
    const byName = (a, b) => collator.compare(a.name, b.name);
    if (sortBy === 'name') {
        items.sort(byName);
    } else if (sortBy === 'kind') {
        const kind = item => item.isDirectory
            ? '' : Gio.content_type_get_description(item.contentType ?? '');
        items.sort((a, b) => collator.compare(kind(a), kind(b)) || byName(a, b));
    } else {
        items.sort((a, b) => b.modified - a.modified || byName(a, b));
    }
    return items;
}

// ─── App-grid folder helpers ────────────────────────────────────────────────

function appFolderSettings(folderId) {
    return new Gio.Settings({
        schema_id: 'org.gnome.desktop.app-folders.folder',
        path: `/org/gnome/desktop/app-folders/folders/${folderId}/`,
    });
}

/**
 * Display name of an app-grid folder. When `translate` is set, the stored
 * name is a .directory file ID whose localized Name we look up.
 *
 * @param {Gio.Settings} settings the folder's settings
 */
export function appFolderName(settings) {
    const name = settings.get_string('name');
    if (!settings.get_boolean('translate'))
        return name;
    try {
        const keyFile = new GLib.KeyFile();
        keyFile.load_from_data_dirs(`desktop-directories/${name}`, GLib.KeyFileFlags.NONE);
        return keyFile.get_locale_string('Desktop Entry', 'Name', null) || name;
    } catch {
        return name;
    }
}

/**
 * The installed apps in an app-grid folder, the same way the app grid finds
 * them: the listed apps plus apps in its categories, minus excluded ones.
 *
 * @param {Gio.Settings} settings the folder's settings
 */
function appFolderApps(settings) {
    const appSystem = Shell.AppSystem.get_default();
    const excluded = new Set(settings.get_strv('excluded-apps'));
    const ids = new Set(settings.get_strv('apps'));

    const categories = settings.get_strv('categories');
    if (categories.length) {
        for (const info of appSystem.get_installed()) {
            if (!info.should_show())
                continue;
            const appCategories = (info.get_categories() ?? '').split(';');
            if (appCategories.some(c => categories.includes(c)))
                ids.add(info.get_id());
        }
    }

    return [...ids]
        .filter(id => !excluded.has(id))
        .map(id => appSystem.lookup_app(id))
        .filter(app => app)
        .sort((a, b) => collator.compare(a.get_name(), b.get_name()));
}

/**
 * A name for a new folder from a category all its apps share, like the app
 * grid does, e.g. "Office" or "Games".
 *
 * @param {Shell.App[]} apps the apps going into the folder
 */
function bestFolderName(apps) {
    const categoryLists = apps.map(app =>
        (app.get_app_info()?.get_categories() ?? '').split(';').filter(c => c));
    const [first = [], ...rest] = categoryLists;
    for (const category of first) {
        if (!rest.every(list => list.includes(category)))
            continue;
        const name = Shell.util_get_translated_folder_name(`${category}.directory`);
        if (name)
            return name;
    }
    return __('Unnamed Folder');
}

/**
 * Make a new app-grid folder holding `apps` and show it as a stack in the
 * dock, in place of those apps.
 *
 * @param {Shell.App[]} apps the apps to put in the folder
 */
export function createAppFolder(apps) {
    const folderId = GLib.uuid_string_random();
    const folders = new Gio.Settings({schema_id: 'org.gnome.desktop.app-folders'});

    const settings = appFolderSettings(folderId);
    settings.delay();
    settings.set_string('name', bestFolderName(apps));
    settings.set_strv('apps', apps.map(app => app.get_id()));
    settings.apply();
    Gio.Settings.sync();

    folders.set_strv('folder-children', [...folders.get_strv('folder-children'), folderId]);

    const dockSettings = Docking.DockManager.settings;
    dockSettings.set_strv('stack-app-folders',
        [...dockSettings.get_strv('stack-app-folders'), folderId]);

    unfavorite(apps);
    return folderId;
}

/**
 * Add an app to an app-grid folder.
 *
 * @param {string} folderId the folder
 * @param {Shell.App} app the app to add
 */
export function addAppToFolder(folderId, app) {
    const id = app.get_id();
    const settings = appFolderSettings(folderId);
    const apps = settings.get_strv('apps');
    if (!apps.includes(id))
        settings.set_strv('apps', [...apps, id]);
    // Apps in category-based folders can be excluded; undo that
    const excluded = settings.get_strv('excluded-apps');
    if (excluded.includes(id))
        settings.set_strv('excluded-apps', excluded.filter(e => e !== id));
}

/**
 * Take an app out of an app-grid folder. The folder is deleted, and its
 * stack removed from the dock, when that was its last app.
 *
 * @param {string} folderId the folder
 * @param {Shell.App} app the app to remove
 */
export function removeAppFromFolder(folderId, app) {
    const id = app.get_id();
    const settings = appFolderSettings(folderId);
    const remaining = appFolderApps(settings).filter(a => a.get_id() !== id);
    if (!remaining.length) {
        deleteAppFolder(folderId);
        return;
    }

    settings.set_strv('apps', settings.get_strv('apps').filter(a => a !== id));
    // A category-based folder would still pick the app up by its category
    if (settings.get_strv('categories').length &&
        !settings.get_strv('excluded-apps').includes(id))
        settings.set_strv('excluded-apps', [...settings.get_strv('excluded-apps'), id]);
}

/**
 * Delete an app-grid folder and remove its stack from the dock.
 *
 * @param {string} folderId the folder
 */
export function deleteAppFolder(folderId) {
    const dockSettings = Docking.DockManager.settings;
    dockSettings.set_strv('stack-app-folders',
        dockSettings.get_strv('stack-app-folders').filter(id => id !== folderId));

    // Resetting all keys deletes the relocatable settings
    const settings = appFolderSettings(folderId);
    for (const key of settings.settings_schema.list_keys())
        settings.reset(key);

    const folders = new Gio.Settings({schema_id: 'org.gnome.desktop.app-folders'});
    folders.set_strv('folder-children',
        folders.get_strv('folder-children').filter(id => id !== folderId));
}

/**
 * Rename an app-grid folder.
 *
 * @param {string} folderId the folder
 * @param {string} name the new name
 */
export function renameAppFolder(folderId, name) {
    const settings = appFolderSettings(folderId);
    settings.delay();
    settings.set_string('name', name);
    settings.set_boolean('translate', false);
    settings.apply();
}

// Moving apps between the dock and folders is not worth a notification, so
// use the quiet versions of the favourites calls when there are any
function unfavorite(apps) {
    const appFavorites = AppFavorites.getAppFavorites();
    const remove = appFavorites._removeFavorite ?? appFavorites.removeFavorite;
    for (const app of apps) {
        if (appFavorites.isFavorite(app.get_id()))
            remove.call(appFavorites, app.get_id());
    }
}

/**
 * Remove an app dragged from the dock from the pinned apps, as it has moved
 * into a folder. Apps dragged from the app grid keep their place.
 *
 * @param {Shell.App} app the app
 * @param {object} dragSource the drag source
 */
export function unfavoriteDraggedApp(app, dragSource) {
    if (dragSource?._isDockAppIcon)
        unfavorite([app]);
}

/**
 * The app being dragged, if it is one that can go in an app folder: not a
 * window-backed app, a location or the trash.
 *
 * @param {object} source the drag source
 */
export function draggedFolderApp(source) {
    const app = Dash.Dash.getAppFromSource(source);
    if (!app || app.is_window_backed() || app.location || app.isTrash)
        return null;
    return app.get_app_info()?.get_id() ? app : null;
}

/**
 * Tracks whether a drag is hovering a folder drop target: it styles the
 * target with `:drop` and stops when the pointer leaves or the drag ends.
 */
export class DropHover {
    constructor(actor) {
        this._actor = actor;
        this._monitor = null;
        actor.connect('destroy', () => this.set(false));
    }

    get active() {
        return !!this._monitor;
    }

    set(hovering) {
        if (hovering === this.active)
            return;

        if (hovering) {
            this._monitor = {
                dragMotion: event => {
                    if (!this._actor.contains(event.targetActor))
                        this.set(false);
                    return DND.DragMotionResult.CONTINUE;
                },
            };
            DND.addDragMonitor(this._monitor);
            Main.overview.connectObject(
                'item-drag-end', () => this.set(false),
                'item-drag-cancelled', () => this.set(false), this);
            this._actor.add_style_pseudo_class('drop');
        } else {
            DND.removeDragMonitor(this._monitor);
            this._monitor = null;
            Main.overview.disconnectObject(this);
            this._actor.remove_style_pseudo_class('drop');
        }
    }
}

// ─── Stack sources ──────────────────────────────────────────────────────────

const StackSource = GObject.registerClass({
    GTypeFlags: GObject.TypeFlags.ABSTRACT,
    Signals: {
        'changed': {},
        'icon-changed': {},
    },
}, class StackSource extends GObject.Object {
    /** Stable ID, used to keep the same dock item across setting changes. */
    get id() {
        throw new GObject.NotImplementedError();
    }

    get name() {
        throw new GObject.NotImplementedError();
    }

    /** Folder that "Open in Files" opens, or null. */
    get location() {
        return null;
    }

    /** Whether the stack has a "Remove from Dock" action. */
    get removable() {
        return true;
    }

    /** Whether to hide the stack from the dock. */
    get isEmpty() {
        return false;
    }

    createIcon(_size) {
        throw new GObject.NotImplementedError();
    }

    /**
     * The items to show when the stack opens: an array, or a promise of one.
     *
     * @param {Gio.Cancellable} _cancellable cancels a slow lookup
     */
    getItems(_cancellable) {
        throw new GObject.NotImplementedError();
    }

    destroy() {
    }
});

const FolderStackSource = GObject.registerClass(
class FolderStackSource extends StackSource {
    constructor(path) {
        super();
        this.path = path;
        this._file = Gio.File.new_for_path(path);
        this._newest = null;
        this._monitor = null;
        this._refreshId = 0;

        Docking.DockManager.settings.connectObject('changed::stack-display-as-stack',
            () => this._syncDisplay(), this);
        this._syncDisplay();
    }

    get id() {
        return `folder:${this.path}`;
    }

    get name() {
        if (this._file.equal(Gio.File.new_for_path(GLib.get_home_dir())))
            return __('Home');
        return GLib.filename_display_basename(this.path);
    }

    get location() {
        return this._file;
    }

    /** Whether the dock icon shows the newest file rather than the folder. */
    get displayAsStack() {
        return Docking.DockManager.settings.get_strv('stack-display-as-stack')
            .includes(this.path);
    }

    set displayAsStack(value) {
        const {settings} = Docking.DockManager;
        const paths = settings.get_strv('stack-display-as-stack').filter(p => p !== this.path);
        if (value)
            paths.push(this.path);
        settings.set_strv('stack-display-as-stack', paths);
    }

    _syncDisplay() {
        if (!this.displayAsStack) {
            this._stopWatching();
            if (this._newest) {
                this._newest = null;
                this.emit('icon-changed');
            }
            return;
        }

        if (!this._monitor) {
            try {
                this._monitor = this._file.monitor_directory(
                    Gio.FileMonitorFlags.WATCH_MOVES, null);
                this._monitor.connect('changed', () => this._queueNewestRefresh());
            } catch (e) {
                logError(e, `StackDock: could not watch ${this.path}`);
            }
        }
        this._refreshNewest();
    }

    _stopWatching() {
        this._monitor?.cancel();
        this._monitor = null;
        this._newestCancellable?.cancel();
        this._newestCancellable = null;
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
    }

    _queueNewestRefresh() {
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, NEWEST_FILE_REFRESH_DELAY, () => {
            this._refreshId = 0;
            this._refreshNewest();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refreshNewest() {
        this._newestCancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._newestCancellable = cancellable;

        let newest = null;
        try {
            const items = await this._enumerate(cancellable);
            for (const item of items) {
                const lower = item.name.toLowerCase();
                if (PARTIAL_DOWNLOAD_SUFFIXES.some(suffix => lower.endsWith(suffix)))
                    continue;
                if (!newest || item.modified > newest.modified)
                    newest = item;
            }
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            logError(e, `StackDock: could not read ${this.path}`);
        }
        if (cancellable.is_cancelled())
            return;
        this._newestCancellable = null;

        if (newest?.uri === this._newest?.uri && newest?.modified === this._newest?.modified)
            return;
        this._newest = newest;
        this.emit('icon-changed');
    }

    createIcon(size) {
        if (this._newest) {
            // A framed thumbnail is drawn a little smaller so it sits inside
            // the same space as an ordinary icon
            const {isThumbnail} = this._newest;
            return new St.Icon({
                gicon: this._newest.gicon,
                icon_size: isThumbnail ? Math.round(size * 0.85) : size,
                style_class: isThumbnail ? 'stackdock-thumbnail' : null,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
        }
        return new St.Icon({
            gicon: new Gio.ThemedIcon({name: folderIconName(this._file)}),
            icon_size: size,
        });
    }

    destroy() {
        this._stopWatching();
        Docking.DockManager.settings.disconnectObject(this);
        super.destroy();
    }

    async getItems(cancellable) {
        const items = await this._enumerate(cancellable);

        // Read the name: the settings wrapper maps enum keys to numbers
        const sortBy = Docking.DockManager.settings.get_string('stack-sort');
        return sortFileItems(items, sortBy).slice(0, MAX_SHOWN);
    }

    async _enumerate(cancellable) {
        const enumerator = await this._file.enumerate_children_async(FILE_ATTRIBUTES,
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);

        const items = [];
        try {
            while (items.length < MAX_ENUMERATED) {
                // eslint-disable-next-line no-await-in-loop
                const infos = await enumerator.next_files_async(100,
                    GLib.PRIORITY_DEFAULT, cancellable);
                if (!infos.length)
                    break;
                for (const info of infos) {
                    if (!info.get_is_hidden() && !info.get_is_backup())
                        items.push(fileItem(this._file, info));
                }
            }
        } finally {
            enumerator.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
        }
        return items;
    }
});

const AppFolderStackSource = GObject.registerClass(
class AppFolderStackSource extends StackSource {
    constructor(folderId) {
        super();
        this.folderId = folderId;
        this._settings = appFolderSettings(folderId);
        this._settings.connectObject('changed', () => this.emit('changed'), this);
        Shell.AppSystem.get_default().connectObject('installed-changed',
            () => this.emit('changed'), this);
    }

    get id() {
        return `app-folder:${this.folderId}`;
    }

    get name() {
        return appFolderName(this._settings) || this.folderId;
    }

    get apps() {
        return appFolderApps(this._settings);
    }

    /** A 2×2 preview of the first apps, like app-grid folders. */
    createIcon(size) {
        const apps = this.apps.slice(0, 4);
        if (!apps.length) {
            return new St.Icon({
                gicon: new Gio.ThemedIcon({name: 'folder-applications'}),
                icon_size: size,
            });
        }

        const padding = Math.round(size / 10);
        const spacing = Math.max(1, Math.round(size / 24));
        const subSize = Math.floor((size - 2 * padding - spacing) / 2);

        const layout = new Clutter.GridLayout({
            row_spacing: spacing,
            column_spacing: spacing,
            row_homogeneous: true,
            column_homogeneous: true,
        });
        const box = new St.Widget({
            style_class: 'stackdock-app-folder-icon',
            layout_manager: layout,
            width: size,
            height: size,
            style: `padding: ${padding}px; border-radius: ${Math.round(size / 4)}px;`,
        });

        apps.forEach((app, i) => {
            layout.attach(new St.Icon({
                gicon: app.get_icon() ?? new Gio.ThemedIcon({name: 'application-x-executable'}),
                icon_size: subSize,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }), i % 2, Math.floor(i / 2), 1, 1);
        });

        return box;
    }

    getItems() {
        return this.apps.map(app => ({
            name: app.get_name(),
            gicon: app.get_icon() ?? new Gio.ThemedIcon({name: 'application-x-executable'}),
            app,
        }));
    }

    destroy() {
        this._settings.disconnectObject(this);
        Shell.AppSystem.get_default().disconnectObject(this);
        super.destroy();
    }
});

const DrivesStackSource = GObject.registerClass(
class DrivesStackSource extends StackSource {
    get id() {
        return 'drives';
    }

    get name() {
        return __('Drives');
    }

    get removable() {
        return false;
    }

    get apps() {
        return Docking.DockManager.getDefault().removables?.getApps() ?? [];
    }

    get isEmpty() {
        return !this.apps.length;
    }

    createIcon(size) {
        return new St.Icon({
            gicon: new Gio.ThemedIcon({name: 'drive-removable-media'}),
            icon_size: size,
        });
    }

    getItems() {
        return this.apps.map(app => ({
            name: app.get_name(),
            gicon: app.get_icon() ?? new Gio.ThemedIcon({name: 'drive-harddisk'}),
            app,
            isDrive: true,
        }));
    }
});

// ─── Stack manager ──────────────────────────────────────────────────────────

/**
 * Keeps the list of stack sources in sync with the settings. One is shared
 * by the docks on all monitors.
 */
export const StackManager = GObject.registerClass({
    Signals: {'changed': {}},
}, class StackManager extends GObject.Object {
    constructor() {
        super();
        this._settings = Docking.DockManager.settings;
        this._appFolders = new Gio.Settings({schema_id: 'org.gnome.desktop.app-folders'});
        this._sources = new Map();
        this._stacks = [];

        this._importDockStacksSettings();

        for (const key of ['stack-folders', 'stack-app-folders', 'stack-drives', 'show-mounts'])
            this._settings.connectObject(`changed::${key}`, () => this._rebuild(), this);
        this._appFolders.connectObject('changed::folder-children', () => this._rebuild(), this);

        this._rebuild();
    }

    /** Stacks placed right after the pinned apps. */
    get pinnedStacks() {
        return this._stacks.filter(s => s instanceof AppFolderStackSource);
    }

    /** Stacks placed at the end of the dock, before the trash. */
    get endStacks() {
        return this._stacks.filter(s => !(s instanceof AppFolderStackSource));
    }

    /** Whether drives are shown as one stack rather than separate icons. */
    get groupsDrives() {
        return this._stacks.some(s => s instanceof DrivesStackSource);
    }

    _rebuild() {
        const {settings} = this;
        const existingFolders = new Set(this._appFolders.get_strv('folder-children'));
        const wanted = [];

        for (const id of settings.get_strv('stack-app-folders')) {
            if (existingFolders.has(id))
                wanted.push([`app-folder:${id}`, () => new AppFolderStackSource(id)]);
        }
        if (settings.get_boolean('stack-drives') && settings.get_boolean('show-mounts'))
            wanted.push(['drives', () => new DrivesStackSource()]);
        for (const path of settings.get_strv('stack-folders'))
            wanted.push([`folder:${path}`, () => new FolderStackSource(path)]);

        // Keep sources that are still wanted so their dock items stay put
        const sources = new Map();
        for (const [id, create] of wanted) {
            if (sources.has(id))
                continue;
            let source = this._sources.get(id);
            if (!source) {
                source = create();
                source.connectObject('changed', () => this.emit('changed'), this);
            }
            sources.set(id, source);
        }
        for (const [id, source] of this._sources) {
            if (!sources.has(id)) {
                source.disconnectObject(this);
                source.destroy();
            }
        }

        this._sources = sources;
        this._stacks = [...sources.values()];
        this.emit('changed');
    }

    get settings() {
        return this._settings;
    }

    removeStack(source) {
        if (source instanceof AppFolderStackSource) {
            this._settings.set_strv('stack-app-folders', this._settings
                .get_strv('stack-app-folders').filter(id => id !== source.folderId));
        } else if (source instanceof FolderStackSource) {
            this._settings.set_strv('stack-folders', this._settings
                .get_strv('stack-folders').filter(path => path !== source.path));
        }
    }

    /** Bring over the stacks set up in the Dock Stacks extension, once. */
    _importDockStacksSettings() {
        if (this._settings.get_boolean('stacks-migrated'))
            return;
        this._settings.set_boolean('stacks-migrated', true);

        try {
            const dir = GLib.build_filenamev([GLib.get_user_data_dir(),
                'gnome-shell', 'extensions', DOCK_STACKS_UUID, 'schemas']);
            const schemaSource = GLib.file_test(dir, GLib.FileTest.IS_DIR)
                ? Gio.SettingsSchemaSource.new_from_directory(dir,
                    Gio.SettingsSchemaSource.get_default(), false)
                : Gio.SettingsSchemaSource.get_default();
            const schema = schemaSource?.lookup(DOCK_STACKS_SCHEMA, true);
            if (!schema)
                return;

            const old = new Gio.Settings({settings_schema: schema});
            const copy = (from, to) => {
                if (schema.has_key(from) && !this._settings.get_strv(to).length)
                    this._settings.set_strv(to, old.get_strv(from));
            };
            copy('configured-folders', 'stack-folders');
            copy('configured-app-folders', 'stack-app-folders');
        } catch (e) {
            logError(e, 'StackDock: could not import Dock Stacks settings');
        }
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._appFolders.disconnectObject(this);
        this._sources.forEach(s => {
            s.disconnectObject(this);
            s.destroy();
        });
        this._sources.clear();
        this._stacks = [];
    }
});

// ─── Actions ────────────────────────────────────────────────────────────────

function launchContext() {
    return global.create_app_launch_context(global.get_current_time(), -1);
}

function openUri(uri) {
    Gio.AppInfo.launch_default_for_uri_async(uri, launchContext(), null, (_, res) => {
        try {
            Gio.AppInfo.launch_default_for_uri_finish(res);
        } catch (e) {
            Main.notifyError(__('Could not open “%s”').format(
                GLib.filename_display_basename(Gio.File.new_for_uri(uri).get_path() ?? uri)),
            e.message);
        }
    });
}

function activateItem(item) {
    if (item.app)
        item.app.activate();
    else if (item.uri)
        openUri(item.uri);
}

function callDBus(busName, objectPath, iface, method, params, replyType = null) {
    // Report errors through the promise, so callers can always use catch()
    try {
        return Gio.DBus.session.call(busName, objectPath, iface, method, params,
            replyType, Gio.DBusCallFlags.NONE, -1, null);
    } catch (e) {
        return Promise.reject(e);
    }
}

function showInFiles(uri) {
    callDBus('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
        'org.freedesktop.FileManager1', 'ShowItems',
        new GLib.Variant('(ass)', [[uri], ''])).catch(e =>
        logError(e, 'StackDock: ShowItems failed'));
}

/** Ask which app to open a file with, using the desktop portal. */
function openWith(item) {
    try {
        const stream = item.file.read(null);
        const fdList = new Gio.UnixFDList();
        fdList.append(stream.get_fd());
        Gio.DBus.session.call_with_unix_fd_list('org.freedesktop.portal.Desktop',
            '/org/freedesktop/portal/desktop', 'org.freedesktop.portal.OpenURI',
            'OpenFile', new GLib.Variant('(sha{sv})', ['', 0, {
                ask: new GLib.Variant('b', true),
            }]), new GLib.VariantType('(o)'), Gio.DBusCallFlags.NONE, -1, fdList,
            null, (connection, res) => {
                try {
                    connection.call_with_unix_fd_list_finish(res);
                } catch (e) {
                    logError(e, 'StackDock: OpenFile failed');
                }
                stream.close(null);
            });
    } catch (e) {
        logError(e, 'StackDock: Open With failed');
    }
}

function previewFile(uri) {
    // Current versions of the previewer (Sushi) only offer the second
    // interface: ShowFile(uri, parent window handle, close if shown, token)
    callDBus('org.gnome.NautilusPreviewer', '/org/gnome/NautilusPreviewer',
        'org.gnome.NautilusPreviewer2', 'ShowFile',
        new GLib.Variant('(ssbs)', [uri, '', false, ''])).catch(e =>
        logError(e, 'StackDock: file preview failed'));
}

async function moveToTrash(item) {
    try {
        await item.file.trash_async(GLib.PRIORITY_DEFAULT, null);
        return true;
    } catch (e) {
        Main.notifyError(__('Could not move “%s” to the trash').format(item.name), e.message);
        return false;
    }
}

/** The folder a Files window is showing, if it is one. */
async function filesWindowLocation(metaWindow) {
    const reply = await callDBus('org.freedesktop.FileManager1',
        '/org/freedesktop/FileManager1', 'org.freedesktop.DBus.Properties', 'Get',
        new GLib.Variant('(ss)', ['org.freedesktop.FileManager1', 'OpenWindowsWithLocations']),
        new GLib.VariantType('(v)'));
    const [windows] = reply.recursiveUnpack();
    const objectPath = metaWindow.get_gtk_window_object_path?.();
    const locations = windows[objectPath] ?? Object.values(windows)[0];
    return locations?.length ? Gio.File.new_for_uri(locations[0]) : null;
}

function copyOrMove(item, destDir, copy) {
    const dest = destDir.get_child(item.file.get_basename());
    const done = (file, res) => {
        try {
            if (copy)
                file.copy_finish(res);
            else
                file.move_finish(res);
        } catch (e) {
            Main.notifyError(copy
                ? __('Could not copy “%s”').format(item.name)
                : __('Could not move “%s”').format(item.name), e.message);
        }
    };
    if (copy) {
        item.file.copy_async(dest, Gio.FileCopyFlags.NONE, GLib.PRIORITY_DEFAULT,
            null, null, done);
    } else {
        item.file.move_async(dest, Gio.FileCopyFlags.NONE, GLib.PRIORITY_DEFAULT,
            null, null, done);
    }
}

function windowAt(x, y) {
    const activeWorkspace = global.workspace_manager.get_active_workspace();
    const actors = global.get_window_actors();
    for (let i = actors.length - 1; i >= 0; i--) {
        const metaWindow = actors[i].meta_window;
        if (!metaWindow || metaWindow.minimized || !metaWindow.showing_on_its_workspace())
            continue;
        if (!metaWindow.located_on_workspace(activeWorkspace))
            continue;
        const rect = metaWindow.get_frame_rect();
        if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height)
            return metaWindow;
    }
    return null;
}

/**
 * Drop a file dragged out of a stack at (x, y):
 * - on a Files window: move it there (Ctrl copies)
 * - on another app's window: open it in that app if it can, else the default app
 * - on the desktop: move it to the Desktop folder (Ctrl copies)
 */
async function dropFile(item, x, y, copy) {
    const metaWindow = windowAt(x, y);
    if (!metaWindow) {
        const desktop = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP);
        if (desktop)
            copyOrMove(item, Gio.File.new_for_path(desktop), copy);
        return;
    }

    const app = Shell.WindowTracker.get_default().get_window_app(metaWindow);
    const appInfo = app?.get_app_info();
    if (appInfo?.get_id() === 'org.gnome.Nautilus.desktop') {
        try {
            const dir = await filesWindowLocation(metaWindow);
            if (dir)
                copyOrMove(item, dir, copy);
        } catch (e) {
            logError(e, 'StackDock: could not find the Files window location');
        }
        return;
    }

    const handlers = Gio.AppInfo.get_all_for_type(item.contentType ?? '');
    if (appInfo && handlers.some(h => h.get_id() === appInfo.get_id()))
        appInfo.launch_uris_async([item.uri], launchContext(), null, null);
    else
        openUri(item.uri);
}

/**
 * Pin an app to the dock at the drop point (x, y), among the pinned apps.
 *
 * @param {object} dash the dock's dash
 * @param {Shell.App} app the app
 * @param {number} x drop x, in stage coordinates
 * @param {number} y drop y, in stage coordinates
 * @param {boolean} isVertical whether the dock is vertical
 */
function pinAppAt(dash, app, x, y, isVertical) {
    const appFavorites = AppFavorites.getAppFavorites();
    const id = app.get_id();
    if (appFavorites.isFavorite(id) || !global.settings.is_writable('favorite-apps'))
        return;

    let pos = 0;
    for (const child of dash._box.get_children()) {
        const childApp = child.child?._delegate?.app;
        if (!childApp || !appFavorites.isFavorite(childApp.get_id()))
            continue;
        const [cx, cy] = child.get_transformed_position();
        const [cw, ch] = child.get_transformed_size();
        if (isVertical ? y > cy + ch / 2 : x > cx + cw / 2)
            pos++;
    }
    const add = appFavorites._addFavorite ?? appFavorites.addFavoriteAtPos;
    add.call(appFavorites, id, pos);
}

// ─── Popups ─────────────────────────────────────────────────────────────────

const clamp = (v, min, max) => Math.max(min, Math.min(v, max));

function scrollIntoView(scrollView, actor) {
    const adjustment = scrollView.vadjustment;
    const {value, pageSize} = adjustment;
    if (actor.y < value)
        adjustment.value = actor.y - GRID_PADDING;
    else if (actor.y + actor.height > value + pageSize)
        adjustment.value = actor.y + actor.height - pageSize + GRID_PADDING;
}

function itemIcon(item, size) {
    return new St.Icon({
        gicon: item.gicon,
        icon_size: size,
        style_class: item.isThumbnail ? 'stackdock-thumbnail' : 'stackdock-item-icon',
    });
}

/**
 * Base for the fan and grid popups. It covers the whole stage and holds a
 * modal grab while open, so clicking anywhere outside it, or pressing
 * Escape, closes it.
 */
const StackPopup = GObject.registerClass({
    GTypeFlags: GObject.TypeFlags.ABSTRACT,
    Signals: {'closed': {}},
}, class StackPopup extends St.Widget {
    constructor(stackIcon, items) {
        super({
            layout_manager: new Clutter.FixedLayout(),
            reactive: true,
        });
        this.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));

        this._stackIcon = stackIcon;
        this._source = stackIcon.source;
        this._items = items;
        this._isOpen = false;
        this._drag = null;

        // Close only on presses on the backdrop itself. Claiming a press that
        // bubbled up from an item would cancel the item's click gesture.
        this.connect('button-press-event', (_actor, event) => {
            if (global.stage.get_event_actor(event) !== this)
                return Clutter.EVENT_PROPAGATE;
            this.close();
            return Clutter.EVENT_STOP;
        });
        this.connect('destroy', () => this._onDestroy());
    }

    /** Where the popup attaches: dock side, icon rectangle, dock edge, work area. */
    _computeAnchor() {
        const {dash} = this._stackIcon;
        const side = Utils.getPosition();
        const [ix, iy] = this._stackIcon.get_transformed_position();
        const [iw, ih] = this._stackIcon.get_transformed_size();
        const [dx, dy] = dash.get_transformed_position();
        const [dw, dh] = dash.get_transformed_size();

        const edge = {
            [St.Side.LEFT]: dx + dw,
            [St.Side.RIGHT]: dx,
            [St.Side.TOP]: dy + dh,
            [St.Side.BOTTOM]: dy,
        }[side];

        return {
            side,
            isVertical: side === St.Side.LEFT || side === St.Side.RIGHT,
            iconX: ix + iw / 2,
            iconY: iy + ih / 2,
            edge,
            workArea: Main.layoutManager.getWorkAreaForMonitor(dash._monitorIndex),
        };
    }

    open() {
        Main.layoutManager.uiGroup.add_child(this);
        this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        this._isOpen = true;
        this._stackIcon.connectObject('destroy', () => this.destroy(), this);
        Main.overview.connectObject(
            'showing', () => this.close(),
            'hiding', () => this.close(), this);

        this._anchor = this._computeAnchor();
        this._build();
        this._animateOpen();
    }

    close() {
        if (!this._isOpen)
            return;
        this._isOpen = false;
        this._endDrag();
        this._menu?.close(BoxPointer.PopupAnimation.NONE);
        this._releaseGrab();
        this.reactive = false;
        this._animateClose(() => this.destroy());
    }

    _releaseGrab() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
    }

    _onDestroy() {
        this._isOpen = false;
        this._endDrag();
        this._releaseGrab();
        this._menuManager = null;
        this._stackIcon.disconnectObject(this);
        Main.overview.disconnectObject(this);
        this.emit('closed');
    }

    /** Make the button for one item: click, right-click menu, drag out. */
    _connectItem(button, item) {
        button.connect('clicked', () => {
            activateItem(item);
            this.close();
        });
        button.connect('popup-menu', () => this._openItemMenu(button, item));
        button.connect('button-press-event', (_actor, event) => {
            if (event.get_button() === Clutter.BUTTON_SECONDARY) {
                this._openItemMenu(button, item);
                return Clutter.EVENT_STOP;
            }
            if (event.get_button() === Clutter.BUTTON_PRIMARY && this._canDragOut(item))
                this._drag = {button, item, start: event.get_coords(), clone: null};
            return Clutter.EVENT_PROPAGATE;
        });
        // St.Button grabs the pointer while pressed, so it sees the motion
        button.connect('motion-event', (_actor, event) => {
            if (this._drag?.button === button && !this._drag.clone) {
                const [x, y] = event.get_coords();
                const [sx, sy] = this._drag.start;
                if (Math.abs(x - sx) > DRAG_THRESHOLD || Math.abs(y - sy) > DRAG_THRESHOLD)
                    this._startDrag(x, y);
            }
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('button-release-event', () => {
            if (this._drag?.button === button && !this._drag.clone)
                this._drag = null;
            return Clutter.EVENT_PROPAGATE;
        });
        button._stackItem = item;
    }

    /** Files can be dragged out anywhere; apps can be dragged out of folders. */
    _canDragOut(item) {
        return !!item.file || (!!item.app && this._source instanceof AppFolderStackSource);
    }

    /** Whether the pointer is over the popup's own content, not the backdrop. */
    _isOverContent(x, y) {
        const actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        return this._itemButtons().some(b => b.contains(actor));
    }

    /**
     * An app dragged out of a folder stack leaves the folder. Dropped on the
     * dock, it is also pinned where it was dropped.
     */
    _dropAppOutside(item, x, y) {
        const {dash} = this._stackIcon;
        const [dx, dy] = dash.get_transformed_position();
        const [dw, dh] = dash.get_transformed_size();
        if (x >= dx && x < dx + dw && y >= dy && y < dy + dh)
            pinAppAt(dash, item.app, x, y, this._anchor.isVertical);
        removeAppFromFolder(this._source.folderId, item.app);
    }

    _startDrag(x, y) {
        const {button} = this._drag;
        // Stop the button's own grab and click; the popup's grab takes over
        button.fake_release();
        const clone = new Clutter.Clone({source: button, opacity: 200, reactive: false});
        Main.layoutManager.uiGroup.add_child(clone);
        clone.set_position(x - button.width / 2, y - button.height / 2);
        this._drag.clone = clone;
        this.ease({opacity: 90, duration: 100, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _endDrag() {
        this._drag?.clone?.destroy();
        this._drag = null;
    }

    vfunc_captured_event(event) {
        const type = event.type();

        if (this._drag?.clone) {
            const [x, y] = event.get_coords();
            if (type === Clutter.EventType.MOTION) {
                const {clone} = this._drag;
                clone.set_position(x - clone.width / 2, y - clone.height / 2);
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.BUTTON_RELEASE) {
                const {item} = this._drag;
                if (item.app) {
                    this._endDrag();
                    if (this._isOverContent(x, y)) {
                        this.ease({opacity: 255, duration: 100});
                    } else {
                        this.close();
                        this._dropAppOutside(item, x, y);
                    }
                    return Clutter.EVENT_STOP;
                }
                const copy = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
                this._endDrag();
                this.close();
                dropFile(item, x, y, copy).catch(e => logError(e, 'StackDock: drop failed'));
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.KEY_PRESS &&
                event.get_key_symbol() === Clutter.KEY_Escape) {
                this._endDrag();
                this.ease({opacity: 255, duration: 100});
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (type === Clutter.EventType.KEY_PRESS)
            return this._onKeyPress(event);
        return Clutter.EVENT_PROPAGATE;
    }

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_space) {
            // Quick Look the focused or hovered file
            const button = [global.stage.key_focus, ...this._itemButtons()]
                .find(b => b?._stackItem && (b === global.stage.key_focus || b.hover));
            if (button?._stackItem.uri) {
                this.close();
                previewFile(button._stackItem.uri);
                return Clutter.EVENT_STOP;
            }
        }
        if (this._moveFocus(symbol))
            return Clutter.EVENT_STOP;
        return Clutter.EVENT_PROPAGATE;
    }

    _itemButtons() {
        return [];
    }

    _moveFocus(symbol) {
        const directions = {
            [Clutter.KEY_Up]: St.DirectionType.UP,
            [Clutter.KEY_Down]: St.DirectionType.DOWN,
            [Clutter.KEY_Left]: St.DirectionType.LEFT,
            [Clutter.KEY_Right]: St.DirectionType.RIGHT,
        };
        if (!(symbol in directions))
            return false;
        const focus = global.stage.key_focus;
        if (!this.contains(focus))
            this._itemButtons()[0]?.grab_key_focus();
        else
            this.navigate_focus(focus, directions[symbol], false);
        return true;
    }

    _openItemMenu(button, item) {
        this._menu?.close(BoxPointer.PopupAnimation.NONE);
        this._menuManager ??= new PopupMenu.PopupMenuManager(this);

        const menu = new PopupMenu.PopupMenu(button, 0.5, St.Side.TOP);
        menu.actor.add_style_class_name('stackdock-item-menu');
        const run = callback => () => {
            this.close();
            callback();
        };

        menu.addAction(__('Open'), run(() => activateItem(item)));
        if (item.file) {
            if (!item.isDirectory)
                menu.addAction(__('Open With…'), run(() => openWith(item)));
            menu.addAction(__('Show in Files'), run(() => showInFiles(item.uri)));
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            menu.addAction(__('Move to Trash'), async () => {
                if (await moveToTrash(item))
                    this._removeItem(button, item);
            });
        } else if (item.app && this._source instanceof AppFolderStackSource) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            menu.addAction(__('Remove from Folder'), () => {
                removeAppFromFolder(this._source.folderId, item.app);
                this._removeItem(button, item);
            });
        } else if (item.isDrive) {
            const {appInfo} = item.app;
            const actions = appInfo?.list_actions?.() ?? [];
            if (actions.length)
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            for (const action of actions) {
                menu.addAction(appInfo.get_action_name(action),
                    run(() => item.app.launch_action(action, global.get_current_time(), -1)));
            }
        }

        Main.layoutManager.uiGroup.add_child(menu.actor);
        this._menuManager.addMenu(menu);
        menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                return;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                menu.destroy();
                return GLib.SOURCE_REMOVE;
            });
            if (this._menu === menu)
                this._menu = null;
        });
        this._menu = menu;
        menu.open(BoxPointer.PopupAnimation.FULL);
    }

    _removeItem(_button, _item) {
        this.close();
    }

    _build() {
        throw new GObject.NotImplementedError();
    }

    _animateOpen() {
        throw new GObject.NotImplementedError();
    }

    _animateClose(_onComplete) {
        throw new GObject.NotImplementedError();
    }
});

/**
 * Fan: a column of items with name labels. Beside a vertical dock it is
 * centred on the icon and bows away from the dock; on a horizontal dock it
 * rises (or drops) from the icon in a curve, like macOS.
 */
const StackFan = GObject.registerClass(
class StackFan extends StackPopup {
    constructor(stackIcon, items) {
        super(stackIcon, items);
        this._buttons = [];
    }

    _itemButtons() {
        return this._buttons;
    }

    _build() {
        const {isVertical, workArea} = this._anchor;
        const room = isVertical ? workArea.height : workArea.height / 2;
        const fits = Math.max(1, Math.floor((room - 2 * SCREEN_MARGIN) / FAN_PITCH));
        const {stackFanMax} = Docking.DockManager.settings;
        const {location} = this._source;

        // Keep a row for "Open in Files" when the stack has a folder
        const maxItems = Math.min(stackFanMax, location ? fits - 1 : fits);
        const shown = this._items.slice(0, Math.max(0, maxItems));

        const entries = shown.map(item => ({item, label: item.name}));
        if (location) {
            const more = this._items.length - shown.length;
            entries.push({
                item: {
                    name: __('Open in Files'),
                    gicon: new Gio.ThemedIcon({name: 'folder-open'}),
                    uri: location.get_uri(),
                },
                label: more > 0
                    ? ngettext('%d more in Files', '%d more in Files', more).format(more)
                    : __('Open in Files'),
                isAction: true,
            });
        }

        for (const entry of entries) {
            const button = this._makeButton(entry);
            this._buttons.push(button);
            this.add_child(button);
        }
        this._layout();
    }

    _makeButton({item, label, isAction}) {
        const {side} = this._anchor;
        const box = new St.BoxLayout({style_class: 'stackdock-fan-item-box'});
        const icon = itemIcon(item, FAN_ICON_SIZE);
        const text = new St.Label({
            style_class: 'stackdock-fan-label',
            text: label,
            y_align: Clutter.ActorAlign.CENTER,
        });
        text.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;

        // The icon sits on the dock side
        const iconFirst = side === St.Side.LEFT;
        box.add_child(iconFirst ? icon : text);
        box.add_child(iconFirst ? text : icon);

        const button = new St.Button({
            style_class: 'stackdock-fan-item',
            child: box,
            can_focus: true,
            track_hover: true,
        });
        if (!iconFirst)
            button.add_style_class_name('stackdock-fan-item-end');
        if (isAction) {
            button.add_style_class_name('stackdock-fan-action');
            button.connect('clicked', () => {
                openUri(item.uri);
                this.close();
            });
        } else {
            this._connectItem(button, item);
        }
        button._iconFirst = iconFirst;
        return button;
    }

    _layout() {
        const {side, isVertical, iconX, iconY, edge, workArea} = this._anchor;
        const n = this._buttons.length;
        const columnHeight = n * FAN_PITCH;
        const columnTop = clamp(iconY - columnHeight / 2, workArea.y + SCREEN_MARGIN,
            workArea.y + workArea.height - columnHeight - SCREEN_MARGIN);

        this._buttons.forEach((button, i) => {
            const [, width] = button.get_preferred_width(-1);
            const [, height] = button.get_preferred_height(width);
            // Offset from the button's edge to the middle of its icon
            const iconOffset = FAN_CARD_INSET + FAN_ICON_SIZE / 2;
            const iconCentre = button._iconFirst ? iconOffset : width - iconOffset;

            let x, y, angle = 0;
            if (isVertical) {
                y = columnTop + i * FAN_PITCH + (FAN_PITCH - height) / 2;
                const rowsFromIcon = Math.abs(y + height / 2 - iconY) / FAN_PITCH;
                const bow = rowsFromIcon ** 1.8 * 2.5;
                x = side === St.Side.LEFT
                    ? edge + POPUP_GAP + bow
                    : edge - POPUP_GAP - width - bow;
            } else {
                const bow = i ** 1.8 * 2.5;
                x = iconX + bow - iconCentre;
                y = side === St.Side.BOTTOM
                    ? edge - POPUP_GAP - (i + 1) * FAN_PITCH
                    : edge + POPUP_GAP + i * FAN_PITCH;
                angle = side === St.Side.BOTTOM ? i * 2.5 : -i * 2.5;
            }

            button.set_pivot_point(iconCentre / width, 0.5);
            button._home = {x, y, angle};
            button._start = {x: iconX - iconCentre, y: iconY - height / 2};
        });
    }

    _animateOpen() {
        this._buttons.forEach((button, i) => {
            const {x, y, angle} = button._home;
            button.set({
                x: button._start.x,
                y: button._start.y,
                scale_x: 0.2,
                scale_y: 0.2,
                opacity: 0,
                rotation_angle_z: angle,
            });
            button.ease({
                x,
                y,
                scale_x: 1,
                scale_y: 1,
                opacity: 255,
                delay: i * 12,
                duration: OPEN_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        });
    }

    _animateClose(onComplete) {
        if (!this._buttons.length) {
            onComplete();
            return;
        }
        this._buttons.forEach((button, i) => {
            button.ease({
                x: button._start.x,
                y: button._start.y,
                scale_x: 0.2,
                scale_y: 0.2,
                opacity: 0,
                duration: CLOSE_TIME,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: i === this._buttons.length - 1 ? onComplete : undefined,
            });
        });
    }
});

/**
 * Grid: a panel with the stack's name, a search field for big stacks, a
 * scrolling grid of items, and a footer bar with the item count and, for
 * folders, "Open in Files". A notch points at the dock icon.
 */
const StackGrid = GObject.registerClass(
class StackGrid extends StackPopup {
    constructor(stackIcon, items) {
        super(stackIcon, items);
        this._buttons = [];
        // The entry loses focus as it is destroyed; ignore that
        this.connect('destroy', () => (this._renameEntry = null));
    }

    close() {
        // Clicking outside, or opening an item, keeps a name being typed
        this._finishRename(true);
        super.close();
    }

    _itemButtons() {
        return this._buttons.filter(b => b.visible);
    }

    _build() {
        const n = this._items.length;
        if (n <= 9)
            this._columns = 3;
        else if (n <= 16)
            this._columns = 4;
        else
            this._columns = 5;

        this._panel = new St.BoxLayout({
            style_class: 'stackdock-grid',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });

        this._buildHeader();

        this._grid = new St.Viewport({
            style_class: 'stackdock-grid-items',
            layout_manager: new Clutter.FixedLayout(),
        });
        this._scrollView = new St.ScrollView({
            style_class: 'stackdock-grid-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: this._grid,
        });
        this._panel.add_child(this._scrollView);

        let emptyText = __('Nothing here');
        if (n)
            emptyText = __('No matches');
        else if (this._source.location)
            emptyText = __('This folder is empty');
        this._emptyLabel = new St.Label({
            style_class: 'stackdock-grid-empty',
            text: emptyText,
            x_align: Clutter.ActorAlign.CENTER,
            visible: !n,
        });
        this._panel.add_child(this._emptyLabel);

        this._buildFooter();

        for (const item of this._items) {
            const button = this._makeButton(item);
            this._buttons.push(button);
            this._grid.add_child(button);
        }

        this._arrow = new St.DrawingArea({style_class: 'stackdock-grid-arrow'});
        this._arrow.connect('repaint', () => this._drawArrow());

        this.add_child(this._panel);
        this.add_child(this._arrow);

        this._filter('');
        this._layout();
    }

    _buildHeader() {
        const header = new St.BoxLayout({
            style_class: 'stackdock-grid-header',
            orientation: Clutter.Orientation.VERTICAL,
        });
        const title = new St.Label({
            style_class: 'stackdock-grid-title',
            text: this._source.name,
            x_align: Clutter.ActorAlign.CENTER,
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._title = title;

        if (this._source instanceof AppFolderStackSource) {
            // Click the name of an app folder to rename it
            this._titleButton = new St.Button({
                style_class: 'stackdock-grid-title-button',
                child: title,
                can_focus: true,
                track_hover: true,
                x_align: Clutter.ActorAlign.CENTER,
                accessible_name: __('Rename Folder'),
            });
            this._titleButton.connect('clicked', () => this.startRename());
            header.add_child(this._titleButton);

            this._renameEntry = new St.Entry({
                style_class: 'stackdock-grid-rename',
                can_focus: true,
                x_expand: true,
                visible: false,
            });
            this._renameEntry.clutter_text.connect('activate', () => this._finishRename(true));
            this._renameEntry.clutter_text.connect('key-focus-out', () => this._finishRename(true));
            header.add_child(this._renameEntry);
        } else {
            header.add_child(title);
        }

        if (this._items.length >= GRID_SEARCH_MIN_ITEMS) {
            this._search = new St.Entry({
                style_class: 'stackdock-grid-search',
                hint_text: __('Search'),
                can_focus: true,
                x_expand: true,
            });
            this._search.set_primary_icon(new St.Icon({
                style_class: 'stackdock-grid-search-icon',
                icon_name: 'edit-find-symbolic',
            }));
            this._search.clutter_text.connect('text-changed',
                () => this._filter(this._search.get_text()));
            this._search.clutter_text.connect('activate', () => {
                const [first] = this._itemButtons();
                if (first) {
                    activateItem(first._stackItem);
                    this.close();
                }
            });
            header.add_child(this._search);
        }
        this._panel.add_child(header);
    }

    /** Swap the title for a text field to rename the app folder. */
    startRename() {
        if (!this._renameEntry || this._renameEntry.visible)
            return;
        this._titleButton.hide();
        this._renameEntry.show();
        this._renameEntry.set_text(this._source.name);
        this._renameEntry.grab_key_focus();
        this._renameEntry.clutter_text.set_selection(0, -1);
    }

    _finishRename(save) {
        if (!this._renameEntry?.visible)
            return;
        const name = this._renameEntry.get_text().trim();
        this._renameEntry.hide();
        this._titleButton.show();
        if (save && name && name !== this._source.name) {
            renameAppFolder(this._source.folderId, name);
            this._title.text = name;
        }
        if (this._isOpen)
            this._titleButton.grab_key_focus();
    }

    _isOverContent(x, y) {
        const actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        return this._panel.contains(actor);
    }

    _buildFooter() {
        const footer = new St.BoxLayout({style_class: 'stackdock-grid-footer'});
        this._countLabel = new St.Label({
            style_class: 'stackdock-grid-count',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        footer.add_child(this._countLabel);

        const {location} = this._source;
        if (location) {
            this._footerButton = new St.Button({
                style_class: 'stackdock-grid-footer-button',
                label: `${__('Open in Files')} ›`,
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._footerButton.connect('clicked', () => {
                openUri(location.get_uri());
                this.close();
            });
            footer.add_child(this._footerButton);
        }
        this._panel.add_child(footer);
    }

    _makeButton(item) {
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        box.add_child(new St.Bin({
            child: itemIcon(item, GRID_ICON_SIZE),
            style_class: 'stackdock-grid-icon-bin',
        }));
        const label = new St.Label({
            style_class: 'stackdock-grid-label',
            text: item.name,
            x_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.set({
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            ellipsize: Pango.EllipsizeMode.END,
            line_alignment: Pango.Alignment.CENTER,
        });
        box.add_child(label);

        const button = new St.Button({
            style_class: 'stackdock-grid-item',
            child: box,
            can_focus: true,
            track_hover: true,
            width: GRID_CELL_WIDTH,
            height: GRID_CELL_HEIGHT,
        });
        this._connectItem(button, item);
        return button;
    }

    /** Show the items matching `term`, packed into the grid in order. */
    _filter(term) {
        const needle = term.trim().toLocaleLowerCase();
        let shown = 0;
        for (const button of this._buttons) {
            const match = !needle || button._stackItem.name.toLocaleLowerCase().includes(needle);
            button.visible = match;
            if (!match)
                continue;
            const col = shown % this._columns;
            const row = Math.floor(shown / this._columns);
            const x = GRID_PADDING + col * (GRID_CELL_WIDTH + GRID_SPACING);
            const y = GRID_PADDING + row * (GRID_CELL_HEIGHT + GRID_SPACING);
            if (this._isOpen && this._laidOut)
                button.ease({x, y, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            else
                button.set_position(x, y);
            shown++;
        }

        const rows = Math.max(1, Math.ceil(shown / this._columns));
        this._grid.set_size(
            2 * GRID_PADDING + this._columns * GRID_CELL_WIDTH + (this._columns - 1) * GRID_SPACING,
            2 * GRID_PADDING + rows * GRID_CELL_HEIGHT + (rows - 1) * GRID_SPACING);
        this._scrollView.visible = shown > 0;
        this._emptyLabel.visible = shown === 0;

        const total = this._items.length;
        this._countLabel.text = shown === total
            ? ngettext('%d item', '%d items', total).format(total)
            : __('%d of %d').format(shown, total);

        if (this._laidOut)
            this._layout({refit: true});
    }

    /**
     * Size the panel to its content (up to the screen height) and place it
     * beside the dock icon.
     *
     * @param {object} [params]
     * @param {boolean} [params.refit] slide into the new place, after a search
     */
    _layout({refit = false} = {}) {
        const {side, isVertical, iconX, iconY, edge, workArea} = this._anchor;
        const {width} = this._grid;
        this._panel.width = width;
        this._scrollView.width = width;
        this._scrollView.height = -1;

        // Limit the height to the screen; the grid scrolls past that
        const [, panelHeight] = this._panel.get_preferred_height(width);
        const [, gridHeight] = this._scrollView.get_preferred_height(width);
        const chrome = panelHeight - (this._scrollView.visible ? gridHeight : 0);
        const room = isVertical
            ? workArea.height - 2 * SCREEN_MARGIN
            : Math.abs(edge - (side === St.Side.BOTTOM ? workArea.y : workArea.y + workArea.height)) -
              POPUP_GAP - ARROW_DEPTH - SCREEN_MARGIN;
        this._scrollView.height = this._scrollView.visible
            ? Math.min(gridHeight, Math.max(GRID_CELL_HEIGHT, room - chrome)) : -1;
        const [, height] = this._panel.get_preferred_height(width);

        const offset = POPUP_GAP + ARROW_DEPTH;
        let x, y;
        if (isVertical) {
            x = side === St.Side.LEFT ? edge + offset : edge - offset - width;
            y = clamp(iconY - height / 2, workArea.y + SCREEN_MARGIN,
                workArea.y + workArea.height - height - SCREEN_MARGIN);
        } else {
            x = clamp(iconX - width / 2, workArea.x + SCREEN_MARGIN,
                workArea.x + workArea.width - width - SCREEN_MARGIN);
            y = side === St.Side.BOTTOM ? edge - offset - height : edge + offset;
        }
        x = Math.round(x);
        y = Math.round(y);
        this._panel.set_pivot_point(
            clamp((iconX - x) / width, 0, 1), clamp((iconY - y) / height, 0, 1));

        // The notch sits on the edge facing the dock, aimed at the icon
        const inset = 16;
        let arrowX, arrowY;
        if (isVertical) {
            this._arrow.set_size(ARROW_DEPTH, ARROW_LENGTH);
            arrowX = side === St.Side.LEFT ? x - ARROW_DEPTH + 1 : x + width - 1;
            arrowY = clamp(iconY - ARROW_LENGTH / 2, y + inset, y + height - inset - ARROW_LENGTH);
        } else {
            this._arrow.set_size(ARROW_LENGTH, ARROW_DEPTH);
            arrowX = clamp(iconX - ARROW_LENGTH / 2, x + inset, x + width - inset - ARROW_LENGTH);
            arrowY = side === St.Side.BOTTOM ? y + height - 1 : y - ARROW_DEPTH + 1;
        }

        const move = (actor, ax, ay) => {
            if (refit)
                actor.ease({x: ax, y: ay, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            else
                actor.set_position(ax, ay);
        };
        move(this._panel, x, y);
        move(this._arrow, Math.round(arrowX), Math.round(arrowY));
        this._laidOut = true;
    }

    _drawArrow() {
        const cr = this._arrow.get_context();
        const [w, h] = this._arrow.get_surface_size();
        const color = this._panel.get_theme_node().get_background_color();
        cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255);
        switch (this._anchor.side) {
        case St.Side.LEFT:
            cr.moveTo(w, 0);
            cr.lineTo(0, h / 2);
            cr.lineTo(w, h);
            break;
        case St.Side.RIGHT:
            cr.moveTo(0, 0);
            cr.lineTo(w, h / 2);
            cr.lineTo(0, h);
            break;
        case St.Side.TOP:
            cr.moveTo(0, h);
            cr.lineTo(w / 2, 0);
            cr.lineTo(w, h);
            break;
        default:
            cr.moveTo(0, 0);
            cr.lineTo(w / 2, h);
            cr.lineTo(w, 0);
        }
        cr.closePath();
        cr.fill();
        cr.$dispose();
    }

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();
        const focus = global.stage.key_focus;
        const inSearch = this._search && focus === this._search.clutter_text;

        if (this._renameEntry?.visible && focus === this._renameEntry.clutter_text) {
            if (symbol === Clutter.KEY_Escape) {
                this._finishRename(false);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (symbol === Clutter.KEY_Escape && inSearch && this._search.get_text()) {
            this._search.set_text('');
            return Clutter.EVENT_STOP;
        }

        if (inSearch) {
            if (symbol === Clutter.KEY_Down || symbol === Clutter.KEY_Tab) {
                this._itemButtons()[0]?.grab_key_focus();
                return Clutter.EVENT_STOP;
            }
            if (symbol === Clutter.KEY_Escape)
                return super._onKeyPress(event);
            return Clutter.EVENT_PROPAGATE;
        }

        const directions = {
            [Clutter.KEY_Up]: St.DirectionType.UP,
            [Clutter.KEY_Down]: St.DirectionType.DOWN,
            [Clutter.KEY_Left]: St.DirectionType.LEFT,
            [Clutter.KEY_Right]: St.DirectionType.RIGHT,
        };
        if (symbol in directions && focus?._stackItem) {
            if (!this._grid.navigate_focus(focus, directions[symbol], false) &&
                symbol === Clutter.KEY_Up)
                this._search?.grab_key_focus();
            else
                scrollIntoView(this._scrollView, global.stage.key_focus);
            return Clutter.EVENT_STOP;
        }

        // Typing anywhere searches
        const unicode = event.get_key_unicode();
        const modifiers = event.get_state() &
            (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK);
        if (this._search && unicode && unicode !== ' ' && !modifiers &&
            GLib.unichar_isprint(unicode)) {
            this._search.grab_key_focus();
            this._search.clutter_text.event(event, false);
            return Clutter.EVENT_STOP;
        }

        return super._onKeyPress(event);
    }

    _removeItem(button, item) {
        this._items = this._items.filter(i => i !== item);
        this._buttons = this._buttons.filter(b => b !== button);
        button.destroy();
        this._filter(this._search?.get_text() ?? '');
    }

    _animateOpen() {
        for (const actor of [this._panel, this._arrow])
            actor.set({opacity: 0});
        this._panel.set({scale_x: 0.92, scale_y: 0.92});
        this._panel.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: OPEN_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        this._arrow.ease({
            opacity: 255,
            delay: OPEN_TIME / 2,
            duration: OPEN_TIME / 2,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _animateClose(onComplete) {
        this._arrow.ease({opacity: 0, duration: CLOSE_TIME / 2});
        this._panel.ease({
            opacity: 0,
            scale_x: 0.92,
            scale_y: 0.92,
            duration: CLOSE_TIME,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: onComplete,
        });
    }
});

// ─── Dock icon ──────────────────────────────────────────────────────────────

/**
 * The dock button for a stack. It works with the dash like an app icon:
 * `icon` is a BaseIcon the dash resizes, and it emits `menu-state-changed`
 * while its popup or menu is open, so the dock stays visible.
 */
export const StackIcon = GObject.registerClass({
    Signals: {
        'menu-state-changed': {param_types: [GObject.TYPE_BOOLEAN]},
    },
}, class StackIcon extends St.Button {
    constructor(source, dash) {
        super({
            style_class: 'overview-tile stackdock-stack',
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_expand: false,
            y_expand: false,
            button_mask: PRIMARY_BUTTON | SECONDARY_BUTTON,
        });
        this._delegate = this;
        this.source = source;
        this.dash = dash;

        this.icon = new IconGrid.BaseIcon(source.name, {
            createIcon: size => source.createIcon(size),
            setSizeManually: true,
            showLabel: false,
        });
        const iconContainer = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        iconContainer.add_child(this.icon);
        this.set_child(iconContainer);

        source.connectObject(
            'changed', () => this.icon.update(),
            'icon-changed', () => this.icon.update(),
            this);
        this.connect('popup-menu', () => this._openMenu());
        this.connect('destroy', () => {
            this._cancellable?.cancel();
            this._popup?.destroy();
            this._menu?.destroy();
        });
    }

    /** An app dragged onto an app-folder stack goes into the folder. */
    _folderDropApp(source) {
        if (!(this.source instanceof AppFolderStackSource))
            return null;
        const app = draggedFolderApp(source);
        return app && !this.source.apps.includes(app) ? app : null;
    }

    handleDragOver(source) {
        const app = this._folderDropApp(source);
        this._dropHover ??= new DropHover(this);
        this._dropHover.set(!!app);
        return app ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.CONTINUE;
    }

    acceptDrop(source) {
        const app = this._folderDropApp(source);
        this._dropHover?.set(false);
        if (!app)
            return false;
        addAppToFolder(this.source.folderId, app);
        unfavoriteDraggedApp(app, source);
        return true;
    }

    vfunc_clicked(button) {
        if (button === Clutter.BUTTON_SECONDARY)
            this._openMenu();
        else
            this.toggle();
    }

    get isOpen() {
        return !!this._popup || !!this._cancellable;
    }

    toggle() {
        if (this._popup)
            this._popup.close();
        else
            this.open().catch(e => logError(e, 'StackDock: could not open stack'));
    }

    /**
     * @param {object} [params]
     * @param {boolean} [params.rename] open the grid with the folder name
     *   ready to edit
     */
    async open({rename = false} = {}) {
        if (this.isOpen)
            return;

        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        let items;
        try {
            items = await this.source.getItems(cancellable);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                Main.notifyError(__('Could not open “%s”').format(this.source.name), e.message);
            return;
        } finally {
            if (this._cancellable === cancellable)
                this._cancellable = null;
        }
        if (cancellable.is_cancelled() || !this.mapped)
            return;

        const {settings} = Docking.DockManager;
        const stackView = settings.get_string('stack-view');
        const {stackFanMax} = settings;
        const useFan = !rename && items.length > 0 &&
            (stackView === 'fan' || (stackView === 'auto' && items.length <= stackFanMax));
        const popup = useFan ? new StackFan(this, items) : new StackGrid(this, items);
        popup.connect('closed', () => {
            if (this._popup === popup) {
                this._popup = null;
                this.remove_style_pseudo_class('checked');
                this.emit('menu-state-changed', false);
            }
        });
        this._popup = popup;
        this.add_style_pseudo_class('checked');
        this.emit('menu-state-changed', true);
        popup.open();
        if (rename)
            popup.startRename();
    }

    _openMenu() {
        this._popup?.close();
        if (!this._menu) {
            this._menu = new PopupMenu.PopupMenu(this, 0.5, Utils.getPosition());
            this._menu.actor.add_style_class_name('dash-to-dock-menu');
            this._menu.connect('open-state-changed', (_menu, isOpen) => {
                if (!isOpen)
                    this.sync_hover();
                this.emit('menu-state-changed', isOpen);
            });
            this._menuManager = new PopupMenu.PopupMenuManager(this);
            this._menuManager.addMenu(this._menu);
            Main.layoutManager.uiGroup.add_child(this._menu.actor);
        }

        const menu = this._menu;
        menu.removeAll();
        const {location} = this.source;
        if (location) {
            menu.addAction(__('Open in Files'), () => openUri(location.get_uri()));
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        const {settings} = Docking.DockManager;
        const viewItem = new PopupMenu.PopupSubMenuMenuItem(__('View as'));
        for (const [value, label] of [
            ['auto', __('Automatic')],
            ['fan', __('Fan')],
            ['grid', __('Grid')],
        ]) {
            const item = viewItem.menu.addAction(label, () => settings.set_string('stack-view', value));
            item.setOrnament(settings.get_string('stack-view') === value
                ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }
        menu.addMenuItem(viewItem);

        if (this.source instanceof FolderStackSource) {
            const displayItem = new PopupMenu.PopupSubMenuMenuItem(__('Display as'));
            for (const [value, label] of [
                [false, __('Folder')],
                [true, __('Stack')],
            ]) {
                const item = displayItem.menu.addAction(label, () => {
                    this.source.displayAsStack = value;
                });
                item.setOrnament(this.source.displayAsStack === value
                    ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            }
            menu.addMenuItem(displayItem);
        }

        if (location) {
            const sortItem = new PopupMenu.PopupSubMenuMenuItem(__('Sort by'));
            for (const [value, label] of [
                ['modified', __('Date Modified')],
                ['name', __('Name')],
                ['kind', __('Kind')],
            ]) {
                const item = sortItem.menu.addAction(label, () => settings.set_string('stack-sort', value));
                item.setOrnament(settings.get_string('stack-sort') === value
                    ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            }
            menu.addMenuItem(sortItem);
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        if (this.source instanceof AppFolderStackSource) {
            menu.addAction(__('Rename Folder…'), () =>
                this.open({rename: true}).catch(e => logError(e, 'StackDock: could not open stack')));
        }
        if (this.source.removable) {
            menu.addAction(__('Remove from Dock'),
                () => Docking.DockManager.getDefault().stacks.removeStack(this.source));
        }
        menu.addAction(__('Stack Settings…'), () => {
            Docking.DockManager.settings.set_string('prefs-page', 'stacks');
            Docking.DockManager.extension.openPreferences();
        });

        menu.open(BoxPointer.PopupAnimation.FULL);
    }
});
