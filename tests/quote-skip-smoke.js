import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {QuoteService} from '../gnome-extension/quote.js';

const configDir = GLib.build_filenamev([GLib.get_user_config_dir(), 'muote']);
const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'muote']);
GLib.mkdir_with_parents(configDir, 0o700);
GLib.mkdir_with_parents(cacheDir, 0o700);
GLib.file_set_contents(
    GLib.build_filenamev([configDir, 'authors.json']),
    JSON.stringify({authors: [], quote_mode: 'custom'}));
GLib.file_set_contents(
    GLib.build_filenamev([configDir, 'settings.json']),
    JSON.stringify({appearance: {language: 'ORIGINAL', max_quote_chars: 581}}));
GLib.file_set_contents(
    GLib.build_filenamev([configDir, 'custom-quotes.muote']),
    'A small test quote +- Test Author +- 1\n');

const service = new QuoteService();
try {
    const chosen = await service.skipQuote();
    if (chosen.quote !== 'A small test quote' || chosen.author !== 'Test Author')
        throw new Error(`Unexpected quote: ${JSON.stringify(chosen)}`);

    const cacheFile = Gio.File.new_for_path(
        GLib.build_filenamev([cacheDir, 'current_quote.txt']));
    const [ok, contents] = cacheFile.load_contents(null);
    const rendered = ok ? new TextDecoder().decode(contents) : '';
    if (rendered !== '"A small test quote" — Test Author')
        throw new Error(`Unexpected cache contents: ${rendered}`);

    print('Custom quote skip and asynchronous persistence succeeded');
} finally {
    service.destroy();
}
