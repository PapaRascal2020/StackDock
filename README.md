# StackDock

One dock for GNOME with stacks, app folders and drives built in.

## Why I made this

Every time GNOME released a new version, my desktop fell apart. The dock I relied on, the stacks extension I liked and the little tweaks I had collected were all made by different people, all on their own release schedules. After an update I would open the Extensions app and see the same message over and over: "not compatible with the current version of GNOME". Then I would wait, sometimes for weeks, for each one to catch up.

Even when everything did work, no single extension gave me what I wanted. I was running several at once, all poking at the same dock, sometimes fighting each other over it. One put the dock where I wanted it, another added stacks, and nothing grouped my drives or let me keep my app folders in the dock.

So I stopped waiting. StackDock is one extension that does all of it, built for the GNOME versions I actually use and kept up to date because I use it every day.

## What it does

**A complete dock.** StackDock is built on [Dash to Dock](https://github.com/micheleg/dash-to-dock), so you get everything you would expect: left, right, top or bottom placement, autohide and intellihide, multi-monitor support, running app indicators, window previews and a full set of appearance options.

**Folder stacks.** Pin any folder (Downloads, Documents, a project folder) to the dock. Click it and your newest files fan out beside the dock. Big folders open as a grid you can scroll and search instead. From a stack you can:

- open a file with a click
- press Space to preview it (needs GNOME's previewer, Sushi)
- right-click for Open With, Show in Files and Move to Trash
- drag a file out onto a Files window to move it there (hold Ctrl to copy), onto an app to open it in that app, or onto the desktop

**App folder stacks.** Your app grid folders can live in the dock, right after your pinned apps, with a little preview of the apps inside. They work like folders on macOS:

- drag one app onto the middle of another in the dock to put them both in a new folder
- drag an app onto a folder stack to add it
- click the folder's name at the top of the grid to rename it (or right-click the stack and choose Rename Folder)
- drag an app out of the folder to take it out. Drop it on the dock to pin it there
- when the last app leaves, the folder is deleted

**A Drives stack.** USB sticks, memory cards and other drives are grouped into one Drives stack instead of each taking up a spot in the dock. Right-click a drive to eject or unmount it. The stack hides itself when nothing is plugged in.

**Easy to set up.** Everything is in one settings window, and you can right-click any stack to change how it opens or how it is sorted.

**Keyboard friendly.** In an open stack, the arrow keys move between items, Enter opens, Space previews, typing searches and Escape closes.

## Requirements

GNOME Shell 49, 50 or 51.

## Installing from GitHub

### 1. Install the build tools

You only need to do this once.

Ubuntu, Debian, Pop!_OS, PikaOS and similar:

    sudo apt install git make gettext sassc libglib2.0-bin

Fedora:

    sudo dnf install git make gettext sassc glib2

Arch and Manjaro:

    sudo pacman -S git make gettext sassc glib2

openSUSE:

    sudo zypper install git make gettext-tools sassc glib2-tools

### 2. Download and install StackDock

    git clone https://github.com/PapaRascal2020/StackDock.git
    cd StackDock
    make install

This installs StackDock for your user only, into `~/.local/share/gnome-shell/extensions/stackdock@ashleyj`. You do not need `sudo`.

### 3. Turn off any other dock

StackDock replaces other docks, and two docks at once will fight. Check what you have enabled:

    gnome-extensions list --enabled

Then turn off any of these that appear:

    gnome-extensions disable dash-to-dock@micxgx.gmail.com
    gnome-extensions disable ubuntu-dock@ubuntu.com
    gnome-extensions disable dock-stacks@dragosr

### 4. Restart GNOME Shell

GNOME only notices new extensions after a restart, so log out and log back in.

### 5. Turn StackDock on

    gnome-extensions enable stackdock@ashleyj

You can also switch it on in the Extensions app.

### 6. Set up your stacks

Open the settings:

    gnome-extensions prefs stackdock@ashleyj

Go to the **Stacks** tab, then:

- press **+** under Folder Stacks to add a folder
- switch on any app folders you want under App Folder Stacks. To make a new one, drag one app onto another in the dock.

If you used Dock Stacks before, StackDock brings your folders over automatically the first time it starts.

## Updating

    cd StackDock
    git pull
    make install

Then log out and back in.

## Uninstalling

    gnome-extensions disable stackdock@ashleyj
    rm -rf ~/.local/share/gnome-shell/extensions/stackdock@ashleyj

Then log out and back in.

## Something not working?

Look for errors from GNOME Shell:

    journalctl --user -b | grep -i stackdock

Please [open an issue](https://github.com/PapaRascal2020/StackDock/issues) with what you were doing, your GNOME version (`gnome-shell --version`) and anything that command shows.

## Credits and licence

StackDock is released under the GNU General Public Licence, version 2 or later. See [COPYING](COPYING).

- Built on [Dash to Dock](https://github.com/micheleg/dash-to-dock) by Michele Gaio and contributors. Their original README is kept in [README.upstream.md](README.upstream.md).
- Stacks code adapted from [Dock Stacks](https://github.com/dragosol/dock-stacks) by dragosol.
