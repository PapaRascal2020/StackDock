# StackDock

A dock for GNOME Shell (49–51) with macOS-style stacks and app folders built in.

- Everything Dash to Dock does: dock position, intellihide, multi-monitor, running indicators, window previews
- Stacks: folders and app folders that open as a grid or a fan from the dock
- Drag one app icon onto another to create a folder. Click the title to rename it.
  Folders are stored as GNOME app-grid folders (`org.gnome.desktop.app-folders`), so they also appear in the Activities app grid.

StackDock replaces both Dash to Dock and Dock Stacks. Disable those before enabling it.

## Build

    make            # needs glib-compile-schemas, msgfmt, and sassc (or: npx sass --no-source-map _stylesheet.scss stylesheet.css)
    make install    # installs to ~/.local/share/gnome-shell/extensions/stackdock@ashleyj

## Credits and license

GPL-2.0-or-later (see COPYING).

- Forked from [Dash to Dock](https://github.com/micheleg/dash-to-dock) by Michele Gaio and contributors (upstream README: `README.upstream.md`).
- Stacks code adapted from [Dock Stacks](https://github.com/dragosol/dock-stacks) by dragosol (GPL-2.0-or-later).
