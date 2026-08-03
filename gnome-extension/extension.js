import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuoteService} from './quote.js';

const AUTHOR_WIDTH = 360;

const DEFAULT_APPEARANCE = {
    font: 'Inter',
    font_size: 32,
    text_color: '#ffffff',
    bg_color: '#811309ff',
    bg_enabled: true,
    stroke_color: '#000000',
    stroke_enabled: false,
    stroke_width: 2,
    shadow_color: '#000000ff',
    shadow_enabled: false,
    shadow_offset: 0.5,
    shadow_blur: 0,
    bg_rounded: true,
    bg_fill: false,
    quote_h_align: 'center',
    quote_v_align: 'bottom',
    author_h_align: 'right',
    author_v_align: 'top',
    quote_x: 210,
    quote_y: 614,
    author_x: 1342,
    author_y: 966,
    quote_max_width: 1499,
    quote_max_height: 315,
    preview_on_top: false,
    positioning_enabled: false,
};

function logError(message, error) {
    console.error(`Muote ${message}: ${error.message}`);
}

function readTextFile(path, cancellable = null) {
    const file = Gio.File.new_for_path(path);
    return new Promise(resolve => {
        file.load_contents_async(cancellable, (source, result) => {
            try {
                const [ok, contents] = source.load_contents_finish(result);
                resolve(ok ? new TextDecoder().decode(contents) : '');
            } catch (error) {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) &&
                    !error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    logError(`could not read ${path}`, error);
                resolve('');
            }
        });
    });
}

function writeTextFile(path, contents) {
    const file = Gio.File.new_for_path(path);
    const bytes = new TextEncoder().encode(contents);
    return new Promise((resolve, reject) => {
        file.replace_contents_async(
            bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null,
            (source, result) => {
                try {
                    source.replace_contents_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
    });
}

async function loadAppearance(path, cancellable) {
    const raw = (await readTextFile(path, cancellable))
        .replace(/^hash:.*$/m, '').trim();
    if (!raw)
        return {...DEFAULT_APPEARANCE};

    try {
        return {...DEFAULT_APPEARANCE, ...JSON.parse(raw).appearance};
    } catch (error) {
        logError('settings are invalid', error);
        return {...DEFAULT_APPEARANCE};
    }
}

async function loadQuote(path, cancellable) {
    const raw = (await readTextFile(path, cancellable)).trim();
    const separator = raw.lastIndexOf(' — ');
    if (separator < 0)
        return {text: raw, author: ''};

    let text = raw.slice(0, separator).trim();
    if (text.startsWith('"') && text.endsWith('"'))
        text = text.slice(1, -1);
    return {text, author: raw.slice(separator + 3).trim()};
}

function finiteNumber(value, fallback, minimum = -Infinity) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(minimum, number) : fallback;
}

function contentBounds(actor, x = actor.x, y = actor.y) {
    const inset = actor._muoteInset ?? 0;
    return {
        x: x + inset,
        y: y + inset,
        width: actor.width - inset * 2,
        height: actor.height - inset * 2,
    };
}

function relationalSnap(start, size, otherStart, otherSize) {
    const candidates = [
        {start: otherStart, line: otherStart},
        {
            start: otherStart + otherSize / 2 - size / 2,
            line: otherStart + otherSize / 2,
        },
        {start: otherStart + otherSize - size, line: otherStart + otherSize},
        {start: otherStart + otherSize, line: otherStart + otherSize},
        {start: otherStart - size, line: otherStart},
    ];
    candidates.sort((a, b) =>
        Math.abs(a.start - start) - Math.abs(b.start - start));
    return Math.abs(candidates[0].start - start) < 15 ? candidates[0] : null;
}

function horizontalAlignment(value) {
    return {
        left: Pango.Alignment.LEFT,
        center: Pango.Alignment.CENTER,
        right: Pango.Alignment.RIGHT,
    }[value] ?? Pango.Alignment.CENTER;
}

function parseColor(value, fallback) {
    let hex = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value ?? '')
        ? value.slice(1)
        : fallback.slice(1);
    if (hex.length === 6)
        hex += 'ff';
    return [
        parseInt(hex.slice(0, 2), 16) / 255,
        parseInt(hex.slice(2, 4), 16) / 255,
        parseInt(hex.slice(4, 6), 16) / 255,
        parseInt(hex.slice(6, 8), 16) / 255,
    ];
}

function alignedX(containerWidth, contentWidth, align) {
    if (align === 'right')
        return containerWidth - contentWidth;
    if (align === 'center')
        return (containerWidth - contentWidth) / 2;
    return 0;
}

function verticalOffset(containerHeight, contentHeight, align) {
    if (align === 'bottom')
        return Math.max(0, containerHeight - contentHeight);
    if (align === 'center')
        return Math.max(0, (containerHeight - contentHeight) / 2);
    return 0;
}

function createLayout(cr, text, width, appearance, fontScale, hAlign) {
    const layout = PangoCairo.create_layout(cr);
    const font = new Pango.FontDescription();
    font.set_family(appearance.font || 'Inter');
    font.set_size(Math.round(finiteNumber(appearance.font_size, 32, 1) *
        fontScale * Pango.SCALE));
    layout.set_font_description(font);
    layout.set_text(text, -1);
    layout.set_width(Math.round(width * Pango.SCALE));
    layout.set_wrap(Pango.WrapMode.WORD);
    layout.set_alignment(horizontalAlignment(hAlign));
    return layout;
}

function lineBackgroundRects(layout, width, joined, align, paddingH, paddingV) {
    const rects = [];
    const iter = layout.get_iter();
    do {
        const [ink, logical] = iter.get_line_extents();
        const inkWidth = ink.width / Pango.SCALE;
        rects.push({
            x: alignedX(width, inkWidth, align) - paddingH,
            y: logical.y / Pango.SCALE - paddingV,
            width: inkWidth + paddingH * 2,
            height: logical.height / Pango.SCALE + paddingV * 2,
        });
    } while (iter.next_line());

    if (!joined || rects.length < 2)
        return rects;

    const maxWidth = Math.max(...rects.map(rect => rect.width - paddingH * 2));
    const minY = Math.min(...rects.map(rect => rect.y + paddingV));
    const maxY = Math.max(...rects.map(rect => rect.y + rect.height - paddingV));
    return [{
        x: alignedX(width, maxWidth, align) - paddingH,
        y: minY - paddingV,
        width: maxWidth + paddingH * 2,
        height: maxY - minY + paddingV * 2,
    }];
}

function roundedRect(cr, {x, y, width, height}, radius) {
    if (radius <= 0) {
        cr.rectangle(x, y, width, height);
        return;
    }
    const r = Math.min(radius, width / 2, height / 2);
    cr.newSubPath();
    cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
    cr.closePath();
}

function drawLayoutPath(cr, layout, x, y, color, width = 0) {
    cr.save();
    cr.moveTo(x, y);
    cr.setSourceRGBA(...color);
    PangoCairo.layout_path(cr, layout);
    if (width > 0) {
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(width);
        cr.stroke();
    } else {
        cr.fill();
    }
    cr.restore();
}

function drawShadow(cr, layout, x, y, appearance, fontScale) {
    if (!appearance.shadow_enabled)
        return;
    const color = parseColor(appearance.shadow_color, '#000000ff');
    const offset = finiteNumber(appearance.shadow_offset, 0.5);
    const blur = finiteNumber(appearance.shadow_blur, 0, 0);
    const size = finiteNumber(appearance.shadow_size, 1, 1);
    const growth = finiteNumber(appearance.font_size, 32, 1) *
        fontScale * (size - 1) * 0.7;
    const draw = (dx, dy, alpha) => {
        const shadow = [...color];
        shadow[3] *= alpha;
        drawLayoutPath(cr, layout, x + offset + dx, y + offset + dy,
            shadow, growth);
    };
    if (blur <= 0) {
        draw(0, 0, 1);
        return;
    }
    const steps = 8;
    for (let step = 0; step < steps; step++) {
        const angle = step / steps * Math.PI * 2;
        draw(Math.cos(angle) * blur, Math.sin(angle) * blur, 1 / steps);
    }
}

function createTextBox({
    text, x, y, width, height, hAlign, vAlign, appearance,
    fontScale = 1, isAuthor = false, interactive = false,
}) {
    const paddingH = isAuthor ? 10 : 12;
    const paddingV = isAuthor ? 4 : 6;
    const strokeExtent = appearance.stroke_enabled
        ? finiteNumber(appearance.stroke_width, 2, 0) / 2
        : 0;
    const shadowGrowth = appearance.shadow_enabled
        ? finiteNumber(appearance.font_size, 32, 1) * fontScale *
            (finiteNumber(appearance.shadow_size, 1, 1) - 1) * 0.7
        : 0;
    const shadowExtent = appearance.shadow_enabled
        ? Math.abs(finiteNumber(appearance.shadow_offset, 0.5)) +
            finiteNumber(appearance.shadow_blur, 0, 0) + shadowGrowth
        : 0;
    const margin = Math.ceil(Math.max(24, paddingH + strokeExtent, paddingH + shadowExtent));
    const box = new St.DrawingArea({
        reactive: interactive,
        can_focus: interactive,
        track_hover: interactive,
        x: x - margin,
        y: y - margin,
        width: width + margin * 2,
        height: height + margin * 2,
    });
    box._muoteInset = margin;
    box.connect('repaint', area => {
        const cr = area.get_context();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        const layout = createLayout(cr, text, width, appearance, fontScale, hAlign);
        const [, layoutHeight] = layout.get_pixel_size();
        const drawX = margin;
        const drawY = margin + verticalOffset(height, layoutHeight, vAlign);

        if (appearance.bg_enabled) {
            const color = parseColor(appearance.bg_color, '#811309ff');
            cr.setSourceRGBA(...color);
            const rects = lineBackgroundRects(layout, width,
                !isAuthor && appearance.bg_fill, hAlign, paddingH, paddingV);
            for (const rect of rects) {
                roundedRect(cr, {
                    ...rect,
                    x: rect.x + drawX,
                    y: rect.y + drawY,
                }, appearance.bg_rounded ? (isAuthor ? 6 : 8) : 0);
                cr.fill();
            }
        }

        if (appearance.stroke_enabled) {
            drawLayoutPath(cr, layout, drawX, drawY,
                parseColor(appearance.stroke_color, '#000000ff'),
                finiteNumber(appearance.stroke_width, 2, 0));
        }
        drawShadow(cr, layout, drawX, drawY, appearance, fontScale);
        cr.moveTo(drawX, drawY);
        cr.setSourceRGBA(...parseColor(appearance.text_color, '#ffffffff'));
        PangoCairo.show_layout(cr, layout);

        if (interactive) {
            cr.setSourceRGBA(0.21, 0.52, 0.89, 1);
            cr.setLineWidth(2);
            cr.rectangle(margin, margin, width, height);
            cr.stroke();
        }
        cr.$dispose();
        return true;
    });
    box.queue_repaint();
    return box;
}

export default class MuoteExtension extends Extension {
    enable() {
        this._quoteService = new QuoteService();
        this._fileCancellable = new Gio.Cancellable();
        this._reloadSerial = 0;
        this._previewOnTop = false;
        this._settingsPath = GLib.build_filenamev([
            GLib.get_user_config_dir(), 'muote', 'settings.json',
        ]);
        this._quotePath = GLib.build_filenamev([
            GLib.get_user_cache_dir(), 'muote', 'current_quote.txt',
        ]);
        this._container = new St.Widget({
            reactive: false,
            x_expand: true,
            y_expand: true,
        });

        // Keep a stable reference to GNOME's background group so Muote can be
        // explicitly lowered again after the interactive positioning overlay closes.
        this._backgroundActor = global.window_group.get_first_child();
        global.window_group.add_child(this._container);
        this._placeBelowWindows();

        this._monitors = [];
        this._reloadSerial++;
        this._watchDirectory(GLib.path_get_dirname(this._settingsPath), 'settings.json');
        this._watchDirectory(GLib.path_get_dirname(this._quotePath), 'current_quote.txt');
        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => this._queueReload());
        this._restackedId = global.display.connect(
            'restacked', () => this._syncLayerOrder());
        this._shortcutSettings = this.getSettings();
        this._shortcutChangedId = this._shortcutSettings.connect(
            'changed::skip-quote-shortcut', () => this._registerSkipShortcut());
        this._registerSkipShortcut();
        this._reload();
    }

    disable() {
        if (this._editLayer)
            this._writeAppearance({});
        this._exitPositioning();
        Main.wm.removeKeybinding('skip-quote-shortcut');
        if (this._shortcutChangedId)
            this._shortcutSettings.disconnect(this._shortcutChangedId);
        this._shortcutChangedId = 0;
        this._shortcutSettings = null;
        if (this._reloadId) {
            GLib.source_remove(this._reloadId);
            this._reloadId = 0;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        if (this._restackedId) {
            global.display.disconnect(this._restackedId);
            this._restackedId = 0;
        }
        for (const [monitor, signalId] of this._monitors) {
            monitor.disconnect(signalId);
            monitor.cancel();
        }
        this._monitors = [];
        this._fileCancellable?.cancel();
        this._fileCancellable = null;
        this._quoteService?.destroy();
        this._quoteService = null;
        this._container?.destroy();
        this._container = null;
        this._backgroundActor = null;
        this._previewOnTop = false;
    }

    _registerSkipShortcut() {
        Main.wm.removeKeybinding('skip-quote-shortcut');
        if (!this._shortcutSettings.get_strv('skip-quote-shortcut').length)
            return;
        Main.wm.addKeybinding(
            'skip-quote-shortcut',
            this._shortcutSettings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            async () => {
                if (this._applicationWindowHasFocus())
                    return;
                if (this._skipping)
                    return;
                const quoteService = this._quoteService;
                this._skipping = true;
                try {
                    await quoteService.skipQuote();
                } catch (error) {
                    if (this._quoteService === quoteService)
                        Main.notify('Muote', error.message);
                } finally {
                    this._skipping = false;
                }
            });
    }

    _applicationWindowHasFocus() {
        const window = global.display.focus_window;
        if (!window || window.get_window_type() === Meta.WindowType.DESKTOP)
            return false;

        // Mutter can briefly retain the last window as focus_window after it
        // was minimized or Shell took focus. Only block the shortcut when the
        // window still owns keyboard focus and is visible on its workspace.
        return window.has_focus() && !window.minimized &&
            window.showing_on_its_workspace();
    }

    _placeBelowWindows() {
        if (!this._container)
            return;

        const parent = this._container.get_parent();
        if (parent !== global.window_group) {
            parent?.remove_child(this._container);
            global.window_group.add_child(this._container);
        }

        let background = this._backgroundActor?.get_parent() === global.window_group
            ? this._backgroundActor
            : global.window_group.get_first_child();
        if (background === this._container)
            background = this._container.get_next_sibling();
        if (background)
            global.window_group.set_child_above_sibling(this._container, background);
        else
            global.window_group.set_child_below_sibling(this._container, null);
    }

    _placeAboveWindows() {
        if (!this._container)
            return;

        const parent = this._container.get_parent();
        if (parent !== global.window_group) {
            parent?.remove_child(this._container);
            global.window_group.add_child(this._container);
        }
        global.window_group.set_child_above_sibling(this._container, null);
    }

    _syncLayerOrder() {
        if (this._previewOnTop)
            this._placeAboveWindows();
        else
            this._placeBelowWindows();
    }

    _watchDirectory(path, basename) {
        const directory = Gio.File.new_for_path(path);
        try {
            directory.make_directory_with_parents(null);
        } catch (error) {
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                logError(`could not create ${path}`, error);
                return;
            }
        }

        try {
            const monitor = directory.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            const signalId = monitor.connect('changed', (_monitor, file, otherFile) => {
                if (file?.get_basename() === basename ||
                    otherFile?.get_basename() === basename) {
                    this._queueReload();
                }
            });
            this._monitors.push([monitor, signalId]);
        } catch (error) {
            logError(`could not monitor ${path}`, error);
        }
    }

    _queueReload() {
        if (this._reloadId)
            GLib.source_remove(this._reloadId);
        this._reloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._reloadId = 0;
            this._reload();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _reload() {
        if (!this._container)
            return;

        const serial = ++this._reloadSerial;
        const cancellable = this._fileCancellable;
        const [appearance, quote] = await Promise.all([
            loadAppearance(this._settingsPath, cancellable),
            loadQuote(this._quotePath, cancellable),
        ]);
        if (!this._container || cancellable?.is_cancelled() ||
            serial !== this._reloadSerial)
            return;
        this._previewOnTop = appearance.preview_on_top === true;
        if (appearance.positioning_enabled) {
            this._enterPositioning(appearance, quote);
            return;
        }

        this._exitPositioning();
        this._syncLayerOrder();
        this._container.destroy_all_children();
        this._container.set_size(global.stage.width, global.stage.height);
        if (!quote.text)
            return;

        const monitor = Main.layoutManager.primaryMonitor ??
            Main.layoutManager.monitors[0] ?? {x: 0, y: 0};
        const quoteWidth = finiteNumber(appearance.quote_max_width, 1499, 1);
        const quoteHeight = finiteNumber(appearance.quote_max_height, 315, 1);
        const quoteBox = createTextBox({
            text: quote.text,
            x: monitor.x + finiteNumber(appearance.quote_x, 210),
            y: monitor.y + finiteNumber(appearance.quote_y, 614),
            width: quoteWidth,
            height: quoteHeight,
            hAlign: appearance.quote_h_align,
            vAlign: appearance.quote_v_align,
            appearance,
        });
        this._container.add_child(quoteBox);

        if (quote.author) {
            const authorHeight = Math.max(48,
                Math.ceil(finiteNumber(appearance.font_size, 32, 1) * 1.4));
            const authorBox = createTextBox({
                text: quote.author,
                x: monitor.x + finiteNumber(appearance.author_x, 1342),
                y: monitor.y + finiteNumber(appearance.author_y, 966),
                width: AUTHOR_WIDTH,
                height: authorHeight,
                hAlign: appearance.author_h_align,
                vAlign: appearance.author_v_align,
                appearance,
                fontScale: 0.8,
                isAuthor: true,
            });
            this._container.add_child(authorBox);
        }
    }

    _makeDraggable(actor) {
        const pressId = actor.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;

            const [pointerX, pointerY] = event.get_coords();
            this._drag = {
                actor,
                pointerX,
                pointerY,
                actorX: actor.x,
                actorY: actor.y,
            };
            this._dragGrab?.dismiss();
            this._dragGrab = global.stage.grab(actor);
            this._pairGuides = [];
            this._guides?.show();
            this._guides?.queue_repaint();
            return Clutter.EVENT_STOP;
        });
        const motionId = actor.connect('motion-event', (_actor, event) => {
            if (this._drag?.actor !== actor)
                return Clutter.EVENT_PROPAGATE;

            const [pointerX, pointerY] = event.get_coords();
            const rawX = Math.round(this._drag.actorX + pointerX - this._drag.pointerX);
            const rawY = Math.round(this._drag.actorY + pointerY - this._drag.pointerY);
            const inset = actor._muoteInset ?? 0;
            const contentWidth = actor.width - inset * 2;
            const contentHeight = actor.height - inset * 2;
            const monitor = Main.layoutManager.primaryMonitor ??
                Main.layoutManager.monitors[0] ?? {
                    x: 0, y: 0, width: global.stage.width, height: global.stage.height,
                };
            const contentX = rawX + inset;
            const centerTarget = monitor.x + monitor.width / 2 - contentWidth / 2;
            const leftTarget = monitor.x + 25;
            const rightTarget = monitor.x + monitor.width - 25 - contentWidth;
            let snappedX = contentX;
            for (const target of [centerTarget, leftTarget, rightTarget]) {
                if (Math.abs(contentX - target) < 15) {
                    snappedX = target;
                    break;
                }
            }
            let snappedY = rawY + inset;
            this._pairGuides = [];
            const other = actor === this._editQuote
                ? this._editAuthor
                : this._editQuote;
            if (other) {
                const otherBounds = contentBounds(other);
                const pairX = relationalSnap(
                    contentX, contentWidth, otherBounds.x, otherBounds.width);
                const pairY = relationalSnap(
                    snappedY, contentHeight, otherBounds.y, otherBounds.height);
                if (pairX) {
                    snappedX = pairX.start;
                    this._pairGuides.push({
                        orientation: 'vertical',
                        position: pairX.line,
                        start: Math.min(snappedY, otherBounds.y) - 12,
                        end: Math.max(
                            snappedY + contentHeight,
                            otherBounds.y + otherBounds.height) + 12,
                    });
                }
                if (pairY) {
                    snappedY = pairY.start;
                    this._pairGuides.push({
                        orientation: 'horizontal',
                        position: pairY.line,
                        start: Math.min(snappedX, otherBounds.x) - 12,
                        end: Math.max(
                            snappedX + contentWidth,
                            otherBounds.x + otherBounds.width) + 12,
                    });
                }
            }
            actor.set_position(
                Math.round(snappedX - inset), Math.round(snappedY - inset));
            this._guides?.queue_repaint();
            return Clutter.EVENT_STOP;
        });
        const releaseId = actor.connect('button-release-event', (_actor, event) => {
            if (event.get_button() !== 1 || this._drag?.actor !== actor)
                return Clutter.EVENT_PROPAGATE;

            this._drag = null;
            this._dragGrab?.dismiss();
            this._dragGrab = null;
            this._pairGuides = [];
            this._guides?.hide();
            return Clutter.EVENT_STOP;
        });
        this._positionSignals.push([actor, pressId, motionId, releaseId]);
    }

    _enterPositioning(appearance, quote) {
        if (this._editLayer)
            return;

        this._container.hide();
        this._positionSignals = [];
        this._editAppearance = appearance;
        this._editLayer = new St.Widget({
            reactive: false,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        Main.uiGroup.add_child(this._editLayer);

        const monitor = Main.layoutManager.primaryMonitor ??
            Main.layoutManager.monitors[0] ?? {x: 0, y: 0};
        this._pairGuides = [];
        this._guides = new St.DrawingArea({
            reactive: false,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
            visible: false,
        });
        this._guidesRepaintId = this._guides.connect('repaint', area => {
            const cr = area.get_context();
            const mx = monitor.x;
            const my = monitor.y;
            const mw = monitor.width ?? global.stage.width;
            const mh = monitor.height ?? global.stage.height;
            cr.setSourceRGBA(1, 0.2, 0.2, 0.8);
            cr.setLineWidth(2);
            cr.setDash([8, 4], 0);
            for (const x of [mx + mw / 2, mx + 25, mx + mw - 25]) {
                cr.moveTo(x, my);
                cr.lineTo(x, my + mh);
                cr.stroke();
            }
            for (const y of [my + 25, my + mh - 25]) {
                cr.moveTo(mx, y);
                cr.lineTo(mx + mw, y);
                cr.stroke();
            }
            cr.setSourceRGBA(0.2, 0.8, 1, 0.95);
            cr.setLineWidth(2.5);
            cr.setDash([5, 3], 0);
            for (const guide of this._pairGuides ?? []) {
                if (guide.orientation === 'vertical') {
                    cr.moveTo(guide.position, guide.start);
                    cr.lineTo(guide.position, guide.end);
                } else {
                    cr.moveTo(guide.start, guide.position);
                    cr.lineTo(guide.end, guide.position);
                }
                cr.stroke();
            }
            cr.$dispose();
        });
        this._editLayer.add_child(this._guides);
        const quoteText = quote.text || 'Drag the quote to its desired position';
        const authorText = quote.author || 'Author';
        const quoteWidth = finiteNumber(appearance.quote_max_width, 1499, 1);
        const quoteHeight = finiteNumber(appearance.quote_max_height, 315, 1);

        this._editQuote = createTextBox({
            text: quoteText,
            x: monitor.x + finiteNumber(appearance.quote_x, 210),
            y: monitor.y + finiteNumber(appearance.quote_y, 614),
            width: quoteWidth,
            height: quoteHeight,
            hAlign: appearance.quote_h_align,
            vAlign: appearance.quote_v_align,
            appearance,
            interactive: true,
        });
        this._editLayer.add_child(this._editQuote);
        this._makeDraggable(this._editQuote);

        const authorHeight = Math.max(48,
            Math.ceil(finiteNumber(appearance.font_size, 32, 1) * 1.4));
        this._editAuthor = createTextBox({
            text: authorText,
            x: monitor.x + finiteNumber(appearance.author_x, 1342),
            y: monitor.y + finiteNumber(appearance.author_y, 966),
            width: AUTHOR_WIDTH,
            height: authorHeight,
            hAlign: appearance.author_h_align,
            vAlign: appearance.author_v_align,
            appearance,
            fontScale: 0.8,
            isAuthor: true,
            interactive: true,
        });
        this._editLayer.add_child(this._editAuthor);
        this._makeDraggable(this._editAuthor);

        const toolbar = new St.BoxLayout({
            reactive: true,
            x: Math.max(12, Math.round((global.stage.width - 560) / 2)),
            y: 24,
            width: 560,
            style: 'spacing: 12px; padding: 12px 16px; border-radius: 12px; background-color: rgba(20, 20, 20, 0.94);',
        });
        toolbar.add_child(new St.Label({
            text: 'Drag the quote and author',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style: 'font-weight: bold;',
        }));
        const cancel = new St.Button({
            label: 'Cancel',
            style_class: 'button',
            can_focus: true,
        });
        cancel.connect('clicked', () => this._finishPositioning(false));
        toolbar.add_child(cancel);
        const save = new St.Button({
            label: 'Save positions',
            style_class: 'button',
            can_focus: true,
        });
        save.connect('clicked', () => this._finishPositioning(true));
        toolbar.add_child(save);
        this._editLayer.add_child(toolbar);
    }

    async _writeAppearance(updates) {
        const raw = (await readTextFile(this._settingsPath))
            .replace(/^hash:.*$/m, '').trim();
        let settings = {appearance: {...DEFAULT_APPEARANCE}};
        if (raw) {
            try {
                settings = JSON.parse(raw);
            } catch (error) {
                logError('settings are invalid', error);
            }
        }
        settings.appearance = {
            ...DEFAULT_APPEARANCE,
            ...settings.appearance,
            ...updates,
            positioning_enabled: false,
        };

        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(this._settingsPath), 0o700);
            await writeTextFile(this._settingsPath, JSON.stringify(settings, null, 2));
        } catch (error) {
            logError('could not save positions', error);
        }
    }

    async _finishPositioning(save) {
        const updates = {};
        if (save && this._editQuote && this._editAuthor) {
            const monitor = Main.layoutManager.primaryMonitor ??
                Main.layoutManager.monitors[0] ?? {x: 0, y: 0};
            updates.quote_x = Math.round(this._editQuote.x +
                this._editQuote._muoteInset - monitor.x);
            updates.quote_y = Math.round(this._editQuote.y +
                this._editQuote._muoteInset - monitor.y);
            updates.author_x = Math.round(this._editAuthor.x +
                this._editAuthor._muoteInset - monitor.x);
            updates.author_y = Math.round(this._editAuthor.y +
                this._editAuthor._muoteInset - monitor.y);
        }
        await this._writeAppearance(updates);
        this._exitPositioning();
        this._reload();
    }

    _exitPositioning() {
        this._drag = null;
        this._dragGrab?.dismiss();
        this._dragGrab = null;
        for (const [actor, ...signalIds] of this._positionSignals ?? []) {
            for (const signalId of signalIds)
                actor.disconnect(signalId);
        }
        this._positionSignals = null;
        if (this._guides && this._guidesRepaintId)
            this._guides.disconnect(this._guidesRepaintId);
        this._guidesRepaintId = 0;
        this._guides?.destroy();
        this._guides = null;
        this._editLayer?.destroy();
        this._editLayer = null;
        this._editQuote = null;
        this._editAuthor = null;
        this._pairGuides = null;
        this._editAppearance = null;
        this._syncLayerOrder();
        this._container?.show();
    }
}
