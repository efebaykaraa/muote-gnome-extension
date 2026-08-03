# Muote

<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/9938e8cf-a750-406f-a19f-3bc29a497e79" />

Muote is a native GNOME Shell desktop quote extension with built-in
preferences. It supports per-line backgrounds, custom styling, alignment
guides, draggable quote and author positioning, custom quotes, translation,
and an assignable skip-quote shortcut.

Muote does not require an external executable. Fetching uses Wikiquote, and
optional translation sends the selected quote text to Google Translate only
when a new quote is requested.

## Building from Source

Clone the repository:

```sh
git clone https://github.com/efebaykaraa/muote-gnome-extension.git
cd muote-gnome-extension
```

```sh
./gnome-extension/install.sh
gnome-extensions enable muote@efebaykaraa.github.com
```

## GNOME Extensions package

Build the uploadable extension bundle with:

```sh
./gnome-extension/pack.sh
```

The resulting ZIP is written to `dist/` and includes the shared quote module,
GSettings schema, and GPL license.
