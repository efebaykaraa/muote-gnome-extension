#!/bin/sh
set -eu

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_dir=$(dirname -- "$source_dir")
output_dir=${1:-"$repository_dir/dist"}

mkdir -p "$output_dir"
gnome-extensions pack --force \
    --out-dir="$output_dir" \
    --extra-source=quote.js \
    --extra-source=../LICENSE \
    --schema=schemas/org.gnome.shell.extensions.muote.gschema.xml \
    "$source_dir"
