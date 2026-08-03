import {QuoteService} from '../gnome-extension/quote.js';

const service = new QuoteService();

try {
    const quotes = await service.fetchWikiquote('Oscar Wilde');
    if (!quotes.length)
        throw new Error('Wikiquote returned no usable quotes');

    const translation = await service.translateQuote('Knowledge is power.', 'tr');
    if (!translation || translation === 'Knowledge is power.')
        throw new Error('Google Translate returned no translation');

    print(`Fetched ${quotes.length} quotes; translation: ${translation}`);
} finally {
    service.destroy();
}

const cancelledService = new QuoteService();
const pendingRequest = cancelledService.fetchWikiquote('Marcus Aurelius');
cancelledService.destroy();

try {
    await pendingRequest;
    throw new Error('Aborted request unexpectedly completed');
} catch (error) {
    if (error.message === 'Aborted request unexpectedly completed')
        throw error;
    print('Pending request was cancelled during cleanup');
}
