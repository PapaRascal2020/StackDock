// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

// The "About" page of the preferences window.

import Adw from 'gi://Adw';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {
    gettext as __,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const REPO_URL = 'https://github.com/PapaRascal2020/StackDock';

/**
 * A row that opens a web page when activated.
 *
 * @param {string} title the row title
 * @param {string} subtitle the row subtitle
 * @param {string} uri the page to open
 */
function linkRow(title, subtitle, uri) {
    const row = new Adw.ActionRow({title, subtitle, activatable: true});
    row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
    row.connect('activated', () =>
        Gtk.show_uri(row.get_root(), uri, 0));
    return row;
}

export const AboutPage = GObject.registerClass(
class AboutPage extends Adw.PreferencesPage {
    constructor(metadata) {
        super({
            name: 'about',
            title: __('About'),
            icon_name: 'help-about-symbolic',
        });

        this._addHeader(metadata);
        this._addLinks(metadata);
        this._addCredits();
        this._addLicence();
    }

    _addHeader(metadata) {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_top: 12,
            margin_bottom: 12,
        });
        box.append(new Gtk.Image({
            icon_name: 'view-app-grid-symbolic',
            pixel_size: 96,
            css_classes: ['dim-label'],
        }));
        box.append(new Gtk.Label({
            label: metadata.name,
            css_classes: ['title-1'],
        }));
        box.append(new Gtk.Label({
            label: __('Version %s').format(`${metadata['version-name'] ?? metadata.version}`),
            css_classes: ['dim-label'],
        }));
        box.append(new Gtk.Label({
            label: metadata.description,
            wrap: true,
            justify: Gtk.Justification.CENTER,
            max_width_chars: 60,
            margin_top: 6,
        }));

        const group = new Adw.PreferencesGroup();
        group.add(box);
        this.add(group);
    }

    _addLinks(metadata) {
        const url = metadata.url ?? REPO_URL;
        const group = new Adw.PreferencesGroup();
        group.add(linkRow(__('Source code'), url, url));
        group.add(linkRow(__('Report a problem'), __('Open an issue on GitHub'),
            `${url}/issues`));
        this.add(group);
    }

    _addCredits() {
        const group = new Adw.PreferencesGroup({title: __('Credits')});
        group.add(new Adw.ActionRow({
            title: 'Ashley Johnson',
            subtitle: __('StackDock'),
        }));
        group.add(linkRow('Dash to Dock',
            __('The dock StackDock is built on, by Michele Gaio and contributors'),
            'https://github.com/micheleg/dash-to-dock'));
        group.add(linkRow('Dock Stacks',
            __('The original stacks code, by dragosol'),
            'https://github.com/dragosol/dock-stacks'));
        this.add(group);
    }

    _addLicence() {
        const group = new Adw.PreferencesGroup();
        group.add(linkRow(__('GNU General Public Licence, version 2 or later'),
            __('This program comes with absolutely no warranty'),
            'https://www.gnu.org/licenses/old-licenses/gpl-2.0.html'));
        this.add(group);
    }
});
