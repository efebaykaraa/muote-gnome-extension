import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {skipQuote} from './quote.js';

const SETTINGS_SCHEMA = 'org.gnome.shell.extensions.muote';
const LANGUAGES = [
    ['ORIGINAL', 'Original'],
    ['TR', 'Turkish'],
    ['EN', 'English'],
    ['DE', 'German'],
    ['FR', 'French'],
    ['ES', 'Spanish'],
    ['IT', 'Italian'],
    ['PT', 'Portuguese'],
    ['RU', 'Russian'],
    ['AR', 'Arabic'],
    ['ZH', 'Chinese'],
    ['JA', 'Japanese'],
    ['KO', 'Korean'],
];

const DEFAULT_APPEARANCE = {
    font: 'Inter',
    font_size: 32,
    text_color: '#ffffff',
    bg_color: '#811309ff',
    bg_enabled: true,
    bg_rounded: true,
    bg_fill: false,
    stroke_color: '#000000',
    stroke_enabled: false,
    stroke_width: 2,
    shadow_color: '#000000ff',
    shadow_enabled: false,
    shadow_offset: 0.5,
    shadow_blur: 0,
    shadow_size: 1,
    language: 'ORIGINAL',
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
    max_quote_chars: 581,
    position_hash: '',
    positioning_enabled: false,
};

const DEFAULT_AUTHORS = {
    authors: [
        {name: 'Karl Marx', weight: 3},
        {name: 'Friedrich Engels', weight: 2},
        {name: 'Vladimir Lenin', weight: 2},
    ],
    show_weight_note: true,
    quote_mode: 'fetch',
};

const CUSTOM_QUOTES_HEADER = `# <Quote> +- <Author> +- <Weight>
# Weight is optional and defaults to 1. A weight of 0 disables a quote.

`;

function readTextFile(path) {
    try {
        const [ok, contents] = Gio.File.new_for_path(path).load_contents(null);
        return ok ? new TextDecoder().decode(contents) : '';
    } catch (error) {
        if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            console.error(`Muote could not read ${path}: ${error.message}`);
        return '';
    }
}

function writeTextFile(path, contents) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    GLib.file_set_contents(path, contents);
}

function loadSettings(path) {
    try {
        const raw = readTextFile(path);
        const parsed = JSON.parse(raw.replace(/^hash:.*$/m, '').trim());
        return {
            ...parsed,
            appearance: {...DEFAULT_APPEARANCE, ...parsed.appearance},
        };
    } catch (error) {
        if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            console.error(`Muote could not load settings: ${error.message}`);
        return {appearance: {...DEFAULT_APPEARANCE}};
    }
}

function saveSettings(path, settings, window) {
    try {
        writeTextFile(path, JSON.stringify(settings, null, 2));
    } catch (error) {
        console.error(`Muote could not save settings: ${error.message}`);
        window.add_toast(new Adw.Toast({title: `Could not save settings: ${error.message}`}));
    }
}

function loadAuthors(path) {
    const raw = readTextFile(path).replace(/^hash:.*$/m, '').trim();
    if (!raw)
        return {
            ...DEFAULT_AUTHORS,
            authors: DEFAULT_AUTHORS.authors.map(author => ({...author})),
        };
    try {
        const parsed = JSON.parse(raw);
        return {
            ...DEFAULT_AUTHORS,
            ...parsed,
            authors: Array.isArray(parsed.authors)
                ? parsed.authors.map(author => ({
                    name: String(author.name ?? ''),
                    weight: Math.max(0, Number(author.weight) || 0),
                }))
                : DEFAULT_AUTHORS.authors.map(author => ({...author})),
        };
    } catch (error) {
        console.error(`Muote could not load authors: ${error.message}`);
        return {
            ...DEFAULT_AUTHORS,
            authors: DEFAULT_AUTHORS.authors.map(author => ({...author})),
        };
    }
}

function saveAuthors(path, authors, window) {
    try {
        writeTextFile(path, JSON.stringify(authors, null, 2));
    } catch (error) {
        console.error(`Muote could not save authors: ${error.message}`);
        window.add_toast(new Adw.Toast({title: `Could not save authors: ${error.message}`}));
    }
}

function loadCustomQuotes(path) {
    const quotes = [];
    for (const rawLine of readTextFile(path).split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#'))
            continue;
        const fields = line.split('+-').map(field => field.trim());
        if (fields.length < 2 || fields.length > 3 || !fields[0] || !fields[1])
            continue;
        const weight = fields.length === 3 ? Number.parseInt(fields[2], 10) : 1;
        if (!Number.isInteger(weight) || weight < 0)
            continue;
        quotes.push({quote: fields[0], author: fields[1], weight});
    }
    return quotes;
}

function saveCustomQuotes(path, quotes, window) {
    try {
        const lines = quotes.map((quote, index) => {
            const text = quote.quote.replace(/[\r\n]+/g, ' ').trim();
            const author = quote.author.replace(/[\r\n]+/g, ' ').trim();
            if (!text || !author)
                throw new Error(`Quote ${index + 1} needs both text and an author`);
            if (text.includes('+-') || author.includes('+-'))
                throw new Error(`Quote ${index + 1} contains the reserved "+-" separator`);
            return `${text} +- ${author} +- ${Math.max(0, Math.round(quote.weight))}`;
        });
        writeTextFile(path, `${CUSTOM_QUOTES_HEADER}${lines.join('\n')}${lines.length ? '\n' : ''}`);
        window.add_toast(new Adw.Toast({title: 'Custom quotes saved'}));
        return true;
    } catch (error) {
        window.add_toast(new Adw.Toast({title: error.message}));
        return false;
    }
}

function addEntry(group, title, appearance, key, save) {
    const row = new Adw.EntryRow({title, text: String(appearance[key])});
    row.connect('changed', () => {
        appearance[key] = row.text;
        save();
    });
    group.add(row);
}

function rgbaToHex(rgba) {
    const component = value => Math.round(value * 255)
        .toString(16).padStart(2, '0');
    return `#${component(rgba.red)}${component(rgba.green)}` +
        `${component(rgba.blue)}${component(rgba.alpha)}`;
}

function addColor(group, title, appearance, key, fallback, save) {
    const rgba = new Gdk.RGBA();
    if (!rgba.parse(String(appearance[key])))
        rgba.parse(fallback);

    const row = new Adw.ActionRow({title});
    const dialog = new Gtk.ColorDialog({
        title,
        with_alpha: true,
    });
    const button = new Gtk.ColorDialogButton({
        dialog,
        rgba,
        valign: Gtk.Align.CENTER,
    });
    button.connect('notify::rgba', () => {
        appearance[key] = rgbaToHex(button.rgba);
        save();
    });
    row.add_suffix(button);
    row.activatable_widget = button;
    group.add(row);
}

function addSwitch(group, title, appearance, key, save) {
    const row = new Adw.SwitchRow({title, active: appearance[key]});
    row.connect('notify::active', () => {
        appearance[key] = row.active;
        save();
    });
    group.add(row);
}

function addSpin(group, title, appearance, key, lower, upper, step, digits, save) {
    const row = new Adw.SpinRow({
        title,
        digits,
        adjustment: new Gtk.Adjustment({
            lower,
            upper,
            step_increment: step,
            page_increment: step * 10,
            value: appearance[key],
        }),
    });
    row.connect('notify::value', () => {
        appearance[key] = row.value;
        save();
    });
    group.add(row);
}

function alignmentButtons(appearance, key, choices, save) {
    const box = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL});
    box.add_css_class('linked');
    let first = null;
    for (const [value, icon, tooltip] of choices) {
        const button = new Gtk.ToggleButton({
            icon_name: icon,
            tooltip_text: tooltip,
            active: appearance[key] === value,
        });
        if (first)
            button.set_group(first);
        else
            first = button;
        button.connect('toggled', () => {
            if (button.active) {
                appearance[key] = value;
                save();
            }
        });
        box.append(button);
    }
    return box;
}

function addAlignmentRow(group, title, appearance, horizontalKey, verticalKey, save) {
    const row = new Adw.ActionRow({title});
    row.add_suffix(alignmentButtons(appearance, horizontalKey, [
        ['left', 'format-justify-left-symbolic', 'Left'],
        ['center', 'format-justify-center-symbolic', 'Center'],
        ['right', 'format-justify-right-symbolic', 'Right'],
    ], save));
    if (verticalKey) {
        row.add_suffix(alignmentButtons(appearance, verticalKey, [
            ['top', 'go-up-symbolic', 'Up'],
            ['center', 'format-justify-center-symbolic', 'Center'],
            ['bottom', 'go-down-symbolic', 'Down'],
        ], save));
    }
    group.add(row);
}

function createSettingsPage(
    path, settings, authorsPath, authorsConfig, shortcutSettings, window) {
    const appearance = settings.appearance;
    const save = () => saveSettings(path, settings, window);
    const page = new Adw.PreferencesPage({
        name: 'settings',
        title: 'Settings',
        icon_name: 'preferences-system-symbolic',
    });

    const positioning = new Adw.PreferencesGroup({
        title: 'Desktop positioning',
        description: 'Move the quote and author at their actual size on the desktop.',
    });
    const positionRow = new Adw.ActionRow({
        title: 'Position on desktop',
        subtitle: 'Drag the quote and author, then save or cancel',
        activatable: true,
    });
    const positionButton = new Gtk.Button({
        label: 'Start',
        valign: Gtk.Align.CENTER,
    });
    positionButton.add_css_class('suggested-action');
    positionRow.add_suffix(positionButton);
    positionRow.activatable_widget = positionButton;
    positionButton.connect('clicked', () => {
        const latest = loadSettings(path);
        latest.appearance.positioning_enabled = true;
        saveSettings(path, latest, window);
        window.add_toast(new Adw.Toast({
            title: 'Positioning mode started on the desktop',
        }));
    });
    positioning.add(positionRow);
    page.add(positioning);

    const source = new Adw.PreferencesGroup({title: 'Quote source'});
    const sourceRow = new Adw.ComboRow({
        title: 'Source',
        subtitle: 'Fetch quotes by author or use your custom quote list',
        model: Gtk.StringList.new(['Fetch', 'Custom']),
        selected: authorsConfig.quote_mode === 'custom' ? 1 : 0,
    });
    sourceRow.connect('notify::selected', () => {
        authorsConfig.quote_mode = sourceRow.selected === 1 ? 'custom' : 'fetch';
        saveAuthors(authorsPath, authorsConfig, window);
    });
    source.add(sourceRow);
    const languageIndex = Math.max(0, LANGUAGES.findIndex(
        ([code]) => code === String(appearance.language).toUpperCase()));
    const languageRow = new Adw.ComboRow({
        title: 'Translation',
        subtitle: 'Translate newly selected quotes with Wikiquote Fetcher',
        model: Gtk.StringList.new(LANGUAGES.map(([, label]) => label)),
        selected: languageIndex,
    });
    languageRow.connect('notify::selected', () => {
        appearance.language = LANGUAGES[languageRow.selected][0];
        save();
    });
    source.add(languageRow);
    if (!GLib.find_program_in_path('wikiquote-fetcher')) {
        source.add(new Adw.ActionRow({
            title: 'Wikiquote Fetcher is not installed',
            subtitle: 'Install it with: yay -S wikiquote-fetcher',
        }));
    }
    page.add(source);

    const actions = new Adw.PreferencesGroup({title: 'Quote actions'});
    const skipRow = new Adw.ActionRow({
        title: 'Skip quote',
        subtitle: 'Choose another quote from the current source',
    });
    const skipButton = new Gtk.Button({
        label: 'Skip now',
        valign: Gtk.Align.CENTER,
    });
    skipButton.connect('clicked', async () => {
        skipButton.sensitive = false;
        skipButton.label = 'Loading…';
        try {
            const quote = await skipQuote();
            window.add_toast(new Adw.Toast({title: `Showing a quote by ${quote.author}`}));
        } catch (error) {
            window.add_toast(new Adw.Toast({title: error.message}));
        } finally {
            skipButton.label = 'Skip now';
            skipButton.sensitive = true;
        }
    });
    skipRow.add_suffix(skipButton);
    actions.add(skipRow);

    let capturingShortcut = false;
    let currentShortcut = shortcutSettings.get_strv('skip-quote-shortcut')[0] ?? '';
    const shortcutRow = new Adw.ActionRow({
        title: 'Skip quote shortcut',
        subtitle: 'Backspace clears the shortcut; Escape cancels assignment',
    });
    const shortcutLabel = new Gtk.ShortcutLabel({
        accelerator: currentShortcut,
        valign: Gtk.Align.CENTER,
    });
    shortcutRow.add_suffix(shortcutLabel);
    const assign = new Gtk.Button({
        label: currentShortcut ? 'Change' : 'Set',
        valign: Gtk.Align.CENTER,
    });
    assign.connect('clicked', () => {
        capturingShortcut = true;
        assign.label = 'Press shortcut…';
        assign.grab_focus();
    });
    shortcutRow.add_suffix(assign);
    actions.add(shortcutRow);

    const keyController = new Gtk.EventControllerKey();
    keyController.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    keyController.connect('key-pressed', (_controller, keyval, _keycode, state) => {
        if (!capturingShortcut)
            return false;
        if (keyval === Gdk.KEY_Escape) {
            capturingShortcut = false;
            assign.label = currentShortcut ? 'Change' : 'Set';
            return true;
        }
        if (keyval === Gdk.KEY_BackSpace) {
            shortcutSettings.set_strv('skip-quote-shortcut', []);
            currentShortcut = '';
            shortcutLabel.accelerator = '';
            assign.label = 'Set';
            capturingShortcut = false;
            return true;
        }
        const modifiers = state & Gtk.accelerator_get_default_mod_mask();
        if (!Gtk.accelerator_valid(keyval, modifiers)) {
            window.add_toast(new Adw.Toast({title: 'Use a valid shortcut with a modifier key'}));
            return true;
        }
        const accelerator = Gtk.accelerator_name(keyval, modifiers);
        shortcutSettings.set_strv('skip-quote-shortcut', [accelerator]);
        currentShortcut = accelerator;
        shortcutLabel.accelerator = accelerator;
        assign.label = 'Change';
        capturingShortcut = false;
        return true;
    });
    window.add_controller(keyController);
    page.add(actions);

    const text = new Adw.PreferencesGroup({title: 'Text'});
    addEntry(text, 'Font family', appearance, 'font', save);
    addSpin(text, 'Font size', appearance, 'font_size', 8, 200, 1, 0, save);
    addColor(text, 'Text color', appearance, 'text_color', '#ffffffff', save);
    addSpin(text, 'Maximum quote characters', appearance, 'max_quote_chars', 1, 5000, 1, 0, save);
    page.add(text);

    const background = new Adw.PreferencesGroup({title: 'Background'});
    addSwitch(background, 'Show background', appearance, 'bg_enabled', save);
    addColor(background, 'Background color', appearance, 'bg_color', '#811309ff', save);
    addSwitch(background, 'Rounded corners', appearance, 'bg_rounded', save);
    addSwitch(background, 'Single background for all lines', appearance, 'bg_fill', save);
    page.add(background);

    const effects = new Adw.PreferencesGroup({title: 'Effects'});
    addSwitch(effects, 'Text outline', appearance, 'stroke_enabled', save);
    addColor(effects, 'Outline color', appearance, 'stroke_color', '#000000ff', save);
    addSpin(effects, 'Outline width', appearance, 'stroke_width', 0, 20, 0.5, 1, save);
    addSwitch(effects, 'Text shadow', appearance, 'shadow_enabled', save);
    addColor(effects, 'Shadow color', appearance, 'shadow_color', '#000000ff', save);
    addSpin(effects, 'Shadow offset', appearance, 'shadow_offset', -20, 20, 0.5, 1, save);
    addSpin(effects, 'Shadow blur', appearance, 'shadow_blur', 0, 50, 0.5, 1, save);
    page.add(effects);

    const placement = new Adw.PreferencesGroup({title: 'Placement'});
    addAlignmentRow(placement, 'Phrase', appearance,
        'quote_h_align', 'quote_v_align', save);
    addAlignmentRow(placement, 'Quoter', appearance,
        'author_h_align', null, save);
    page.add(placement);

    return page;
}

function createAuthorsPage(path, config, window) {
    const page = new Adw.PreferencesPage({
        name: 'authors',
        title: 'Authors',
        icon_name: 'system-users-symbolic',
    });

    const group = new Adw.PreferencesGroup({
        title: 'Authors',
        description: 'Weights are relative; higher values select an author more often.',
    });
    const rows = [];
    const render = () => {
        for (const row of rows)
            group.remove(row);
        rows.length = 0;

        config.authors.forEach((author, index) => {
            const row = new Adw.ActionRow({title: `Author ${index + 1}`});
            const name = new Gtk.Entry({
                text: author.name,
                width_chars: 22,
                hexpand: true,
                valign: Gtk.Align.CENTER,
            });
            name.connect('changed', () => {
                author.name = name.text;
                saveAuthors(path, config, window);
            });
            row.add_suffix(name);

            const weight = new Gtk.SpinButton({
                adjustment: new Gtk.Adjustment({
                    lower: 0,
                    upper: 9999,
                    step_increment: 1,
                    page_increment: 10,
                    value: author.weight,
                }),
                width_chars: 4,
                valign: Gtk.Align.CENTER,
            });
            weight.connect('value-changed', () => {
                author.weight = Math.round(weight.value);
                saveAuthors(path, config, window);
            });
            row.add_suffix(weight);

            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: 'Remove author',
                valign: Gtk.Align.CENTER,
            });
            remove.add_css_class('flat');
            remove.connect('clicked', () => {
                config.authors.splice(index, 1);
                saveAuthors(path, config, window);
                render();
            });
            row.add_suffix(remove);
            rows.push(row);
            group.add(row);
        });

        const add = new Adw.ActionRow({
            title: 'Add author',
            activatable: true,
        });
        add.add_prefix(new Gtk.Image({icon_name: 'list-add-symbolic'}));
        add.connect('activated', () => {
            config.authors.push({name: 'New Author', weight: 1});
            saveAuthors(path, config, window);
            render();
        });
        rows.push(add);
        group.add(add);
    };
    render();
    page.add(group);
    return page;
}

function createCustomQuotesPage(path, window) {
    let quotes = loadCustomQuotes(path);
    const page = new Adw.PreferencesPage({
        name: 'custom-quotes',
        title: 'Custom Quotes',
        icon_name: 'document-edit-symbolic',
    });
    const group = new Adw.PreferencesGroup({
        title: 'Custom quotes',
        description: 'Weights are relative; 0 disables a quote.',
    });
    const rows = [];

    const render = () => {
        for (const row of rows)
            group.remove(row);
        rows.length = 0;

        const actions = new Adw.ActionRow({
            title: 'Quote list',
            subtitle: `${quotes.length} custom quote${quotes.length === 1 ? '' : 's'}`,
        });
        const revert = new Gtk.Button({
            label: 'Revert',
            valign: Gtk.Align.CENTER,
        });
        revert.connect('clicked', () => {
            quotes = loadCustomQuotes(path);
            render();
        });
        actions.add_suffix(revert);
        const add = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: 'Add quote',
            valign: Gtk.Align.CENTER,
        });
        add.add_css_class('suggested-action');
        add.connect('clicked', () => {
            quotes.push({quote: 'New quote', author: 'Author', weight: 1});
            render();
        });
        actions.add_suffix(add);
        const save = new Gtk.Button({
            label: 'Save',
            valign: Gtk.Align.CENTER,
        });
        save.add_css_class('suggested-action');
        save.connect('clicked', () => saveCustomQuotes(path, quotes, window));
        actions.add_suffix(save);
        rows.push(actions);
        group.add(actions);

        quotes.forEach((quote, index) => {
            const item = new Adw.ExpanderRow({
                title: quote.author || `Quote ${index + 1}`,
                subtitle: quote.quote,
            });
            const quoteEntry = new Adw.EntryRow({title: 'Quote', text: quote.quote});
            quoteEntry.connect('changed', () => {
                quote.quote = quoteEntry.text;
                item.subtitle = quote.quote;
            });
            item.add_row(quoteEntry);

            const authorEntry = new Adw.EntryRow({title: 'Author', text: quote.author});
            authorEntry.connect('changed', () => {
                quote.author = authorEntry.text;
                item.title = quote.author || `Quote ${index + 1}`;
            });
            item.add_row(authorEntry);

            const weight = new Adw.SpinRow({
                title: 'Weight',
                adjustment: new Gtk.Adjustment({
                    lower: 0,
                    upper: 9999,
                    step_increment: 1,
                    page_increment: 10,
                    value: quote.weight,
                }),
            });
            weight.connect('notify::value', () => {
                quote.weight = Math.round(weight.value);
            });
            item.add_row(weight);

            const removeRow = new Adw.ActionRow({title: 'Remove this quote'});
            const remove = new Gtk.Button({
                label: 'Remove',
                valign: Gtk.Align.CENTER,
            });
            remove.add_css_class('destructive-action');
            remove.connect('clicked', () => {
                quotes.splice(index, 1);
                render();
            });
            removeRow.add_suffix(remove);
            item.add_row(removeRow);
            rows.push(item);
            group.add(item);
        });
    };
    render();
    page.add(group);
    return page;
}

export default class MuotePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settingsPath = GLib.build_filenamev([
            GLib.get_user_config_dir(), 'muote', 'settings.json',
        ]);
        const authorsPath = GLib.build_filenamev([
            GLib.get_user_config_dir(), 'muote', 'authors.json',
        ]);
        const customQuotesPath = GLib.build_filenamev([
            GLib.get_user_config_dir(), 'muote', 'custom-quotes.muote',
        ]);
        const settings = loadSettings(settingsPath);
        const authorsConfig = loadAuthors(authorsPath);
        const shortcutSettings = this.getSettings(SETTINGS_SCHEMA);
        const settingsPage = createSettingsPage(
            settingsPath, settings, authorsPath, authorsConfig, shortcutSettings, window);
        const authorsPage = createAuthorsPage(authorsPath, authorsConfig, window);
        const customQuotesPage = createCustomQuotesPage(customQuotesPath, window);
        window.add(settingsPage);
        window.add(authorsPage);
        window.add(customQuotesPage);
        window.set_visible_page(settingsPage);
    }
}
