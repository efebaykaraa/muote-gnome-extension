#!/bin/sh
set -eu

uuid='muote@efebaykaraa.github.com'
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
extension_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"

mkdir -p "$extension_dir"
install -m 0644 "$source_dir/metadata.json" "$extension_dir/metadata.json"
install -m 0644 "$source_dir/extension.js" "$extension_dir/extension.js"
install -m 0644 "$source_dir/prefs.js" "$extension_dir/prefs.js"
install -m 0644 "$source_dir/quote.js" "$extension_dir/quote.js"
install -m 0644 "$source_dir/stylesheet.css" "$extension_dir/stylesheet.css"
install -Dm644 "$source_dir/schemas/org.gnome.shell.extensions.muote.gschema.xml" \
    "$extension_dir/schemas/org.gnome.shell.extensions.muote.gschema.xml"
glib-compile-schemas "$extension_dir/schemas"

echo "Installed $uuid"
echo "Enable it with: gnome-extensions enable $uuid"
if [ "${XDG_SESSION_TYPE:-}" = wayland ]; then
    echo "Log out and back in to load changed extension code on Wayland."
fi
