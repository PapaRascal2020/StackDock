// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {AboutPage} from './aboutPrefs.js';
import {createDockPages} from './dockPrefs.js';
import {StacksPage} from './stacksPrefs.js';

const WINDOW_MIN_WIDTH = 720;
const WINDOW_MIN_HEIGHT = 600;

/**
 * Open the window at a size where every page fits without resizing: about
 * half the screen wide and most of its height, never below the minimum.
 *
 * @param {Gtk.Window} window the preferences window
 */
function sizeWindow(window) {
    let width = 900, height = 860;
    const monitor = Gdk.Display.get_default()?.get_monitors().get_item(0);
    if (monitor) {
        const {width: screenWidth, height: screenHeight} = monitor.get_geometry();
        width = Math.min(Math.max(WINDOW_MIN_WIDTH, Math.round(screenWidth * 0.5)),
            1000, screenWidth);
        height = Math.min(Math.max(WINDOW_MIN_HEIGHT, Math.round(screenHeight * 0.85)),
            1000, screenHeight);
    }
    window.set_size_request(Math.min(WINDOW_MIN_WIDTH, width), Math.min(WINDOW_MIN_HEIGHT, height));
    window.set_default_size(width, height);
}

// The page switcher sits tight against the top of the window, so give it a
// little room. Added once, as the preferences process can open many windows.
let styleAdded = false;

/**
 * @param {Gtk.Window} window the preferences window
 */
function addStyle(window) {
    window.add_css_class('stackdock-prefs');
    if (styleAdded)
        return;
    const css = new Gtk.CssProvider();
    css.load_from_string('window.stackdock-prefs headerbar viewswitcher { margin-top: 6px; }');
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    styleAdded = true;
}

export default class DockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        sizeWindow(window);
        addStyle(window);
        window.search_enabled = true;

        const settings = this.getSettings('org.gnome.shell.extensions.stackdock');
        const dock = createDockPages(settings);
        dock.pages.forEach(page => window.add(page));
        window.add(new StacksPage(settings));
        window.add(new AboutPage(this.metadata));

        // The dock menu asks for a page by setting prefs-page, both when it
        // opens the window and when the window is already open.
        const showRequestedPage = () => {
            const page = settings.get_string('prefs-page');
            if (!page)
                return;
            window.set_visible_page_name(page === 'dock' ? 'position' : page);
            settings.set_string('prefs-page', '');
        };
        showRequestedPage();
        const id = settings.connect('changed::prefs-page', showRequestedPage);
        window.connect('close-request', () => {
            settings.disconnect(id);
            dock.destroy();
        });
    }
}
