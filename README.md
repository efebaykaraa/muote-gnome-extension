# Muote

<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/9938e8cf-a750-406f-a19f-3bc29a497e79" />

Muote is a native GNOME Shell desktop quote extension with built-in
preferences. The quote is part of GNOME's background layer, so it works on
Wayland and stays below application windows.

## How It Fits Together

- `gnome-extension/extension.js`: native GNOME Shell desktop display
- `gnome-extension/prefs.js`: built-in appearance and placement settings

## Building from Source

Clone the repository:

```sh
git clone https://github.com/efebaykaraa/muote.git
cd muote
```

```sh
./gnome-extension/install.sh
gnome-extensions enable muote@efebaykaraa.github.com
```

The extension supports GNOME Shell 45 through 50. It watches Muote's settings,
so preference changes update the desktop without restarting GNOME Shell.
Use **Position on desktop** in the extension preferences to drag the quote and
author at their real rendered size, then save or cancel from the desktop bar.

## Wikiquote Fetching and Translation

Fetching new Wikiquote pools and translating quotes use the separate
`wikiquote-fetcher` command. On Arch Linux, install it from the AUR:

```sh
yay -S wikiquote-fetcher
```

Muote continues to display cached or custom quotes without it. The preferences
window also shows this installation instruction when the command is missing.
