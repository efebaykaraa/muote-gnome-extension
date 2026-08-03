import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

function readText(path) {
    try {
        const [ok, contents] = Gio.File.new_for_path(path).load_contents(null);
        return ok ? new TextDecoder().decode(contents) : '';
    } catch (error) {
        if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            console.error(`Muote could not read ${path}: ${error.message}`);
        return '';
    }
}

function readJson(path, fallback) {
    const raw = readText(path).replace(/^hash:.*$/m, '').trim();
    if (!raw)
        return fallback;
    try {
        return JSON.parse(raw);
    } catch (error) {
        console.error(`Muote could not parse ${path}: ${error.message}`);
        return fallback;
    }
}

function writeText(path, contents) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    GLib.file_set_contents(path, contents);
}

function weightedChoice(items) {
    const total = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
    if (total <= 0)
        return null;
    let choice = Math.random() * total;
    for (const item of items) {
        choice -= Math.max(0, item.weight);
        if (choice < 0)
            return item;
    }
    return items.at(-1) ?? null;
}

function parseCurrent(raw) {
    const separator = raw.lastIndexOf(' — ');
    if (separator < 0)
        return {quote: raw.trim().replace(/^"|"$/g, ''), author: ''};
    return {
        quote: raw.slice(0, separator).trim().replace(/^"|"$/g, ''),
        author: raw.slice(separator + 3).trim(),
    };
}

function parseCustomQuotes(path) {
    const quotes = [];
    for (const rawLine of readText(path).split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#'))
            continue;
        const fields = line.split('+-').map(field => field.trim());
        const weight = fields.length === 3 ? Number.parseInt(fields[2], 10) : 1;
        if (fields.length >= 2 && fields.length <= 3 && fields[0] && fields[1] &&
            Number.isInteger(weight) && weight >= 0) {
            quotes.push({quote: fields[0], author: fields[1], weight});
        }
    }
    return quotes;
}

function poolPath(configDir, author) {
    const key = [...author].map(character =>
        /[a-z0-9_-]/i.test(character) ? character : '_').join('');
    return GLib.build_filenamev([configDir, 'pools', `${key}.json`]);
}

function fetcherPath() {
    const path = GLib.find_program_in_path('wikiquote-fetcher');
    if (!path) {
        throw new Error(
            'Wikiquote Fetcher is not installed. Install it with: yay -S wikiquote-fetcher');
    }
    return path;
}

function runFetcher(args) {
    const process = Gio.Subprocess.new(
        [fetcherPath(), ...args],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    return new Promise((resolve, reject) => {
        process.communicate_utf8_async(null, null, (source, result) => {
            try {
                const [, stdout, stderr] = source.communicate_utf8_finish(result);
                if (!source.get_successful()) {
                    reject(new Error((stderr || stdout ||
                        'Wikiquote Fetcher failed').trim()));
                    return;
                }
                resolve((stdout ?? '').trim());
            } catch (error) {
                reject(error);
            }
        });
    });
}

function fetchCandidates(enabledAuthors, configDir, current, maxChars) {
    return enabledAuthors.map(author => {
        const path = poolPath(configDir, author.name);
        const pool = readJson(path, {key: author.name, quotes: []});
        let quotes = (pool.quotes ?? []).filter(quote =>
            typeof quote === 'string' && [...quote].length <= maxChars);
        const alternatives = quotes.filter(quote =>
            quote !== current.quote || author.name !== current.author);
        if (alternatives.length)
            quotes = alternatives;
        return {...author, path, pool, quotes};
    }).filter(author => author.quotes.length);
}

export async function skipQuote() {
    const configDir = GLib.build_filenamev([GLib.get_user_config_dir(), 'muote']);
    const cachePath = GLib.build_filenamev([
        GLib.get_user_cache_dir(), 'muote', 'current_quote.txt',
    ]);
    const authors = readJson(GLib.build_filenamev([configDir, 'authors.json']), {
        authors: [],
        quote_mode: 'fetch',
    });
    const settings = readJson(GLib.build_filenamev([configDir, 'settings.json']), {
        appearance: {max_quote_chars: 581},
    });
    const maxChars = Math.max(1, Number(settings.appearance?.max_quote_chars) || 581);
    const current = parseCurrent(readText(cachePath));

    let chosen = null;
    if (authors.quote_mode === 'custom') {
        let quotes = parseCustomQuotes(
            GLib.build_filenamev([configDir, 'custom-quotes.muote']))
            .filter(quote => quote.weight > 0 && [...quote.quote].length <= maxChars);
        const alternatives = quotes.filter(quote =>
            quote.quote !== current.quote || quote.author !== current.author);
        if (alternatives.length)
            quotes = alternatives;
        chosen = weightedChoice(quotes);
    } else {
        const enabledAuthors = (authors.authors ?? []).filter(author =>
            String(author.name ?? '').trim() && Number(author.weight) > 0);
        if (!enabledAuthors.length)
            throw new Error('No enabled authors are configured');
        let candidates = fetchCandidates(
            enabledAuthors, configDir, current, maxChars);
        if (!candidates.length) {
            const author = weightedChoice(enabledAuthors);
            await runFetcher([
                'pool', '--dir', GLib.build_filenamev([configDir, 'pools']),
                'fetch', author.name,
            ]);
            candidates = fetchCandidates(
                enabledAuthors, configDir, current, maxChars);
        }
        const selectedAuthor = weightedChoice(candidates);
        if (!selectedAuthor)
            throw new Error('Wikiquote Fetcher did not return a usable quote');

        const index = Math.floor(Math.random() * selectedAuthor.quotes.length);
        chosen = {
            quote: selectedAuthor.quotes[index],
            author: selectedAuthor.name,
        };
        chosen.poolQuote = chosen.quote;
        chosen.pool = selectedAuthor.pool;
        chosen.poolPath = selectedAuthor.path;
    }

    if (!chosen)
        throw new Error('No enabled quote fits the current display');
    const language = String(settings.appearance?.language ?? 'ORIGINAL')
        .trim().toUpperCase();
    if (language !== 'ORIGINAL' && language !== 'AUTO')
        chosen.quote = await runFetcher(['translate', language, chosen.quote]);
    if (chosen.pool) {
        chosen.pool.quotes = (chosen.pool.quotes ?? [])
            .filter(quote => quote !== chosen.poolQuote);
        writeText(chosen.poolPath, JSON.stringify(chosen.pool, null, 2));
        delete chosen.pool;
        delete chosen.poolPath;
        delete chosen.poolQuote;
    }
    writeText(cachePath, `"${chosen.quote}" — ${chosen.author}`);
    return chosen;
}
