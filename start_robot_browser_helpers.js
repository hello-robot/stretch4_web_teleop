const DEFAULT_MAX_CONSOLE_MESSAGE_CHARS = 4000;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 200;
const DEFAULT_MAX_RETRY_DELAY_MS = 5000;

function truncateLogMessage(
    message,
    maxChars = DEFAULT_MAX_CONSOLE_MESSAGE_CHARS,
) {
    const text = String(message);
    if (text.length <= maxChars) return text;

    const omittedChars = text.length - maxChars;
    return `${text.slice(0, maxChars)}… [${omittedChars} chars omitted]`;
}

function formatBrowserConsoleMessage(
    message,
    maxChars = DEFAULT_MAX_CONSOLE_MESSAGE_CHARS,
) {
    const type = message.type().slice(0, 3).toUpperCase();
    return {
        type,
        text: truncateLogMessage(message.text(), maxChars),
    };
}

function retryDelayMs(
    attempt,
    initialDelayMs = DEFAULT_INITIAL_RETRY_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_RETRY_DELAY_MS,
) {
    return Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
}

function errorSummary(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.split("\n", 1)[0];
}

function shouldLogFullError(attempt, maxAttempts) {
    return attempt === 1 || attempt % 10 === 0 || attempt === maxAttempts;
}

function isClosedTargetError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /Target page, context or browser has been closed/i.test(message);
}

async function navigateWithRetry({
    navigate,
    sleep,
    log,
    maxAttempts = 50,
    initialDelayMs = DEFAULT_INITIAL_RETRY_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_RETRY_DELAY_MS,
}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            await navigate();
            return;
        } catch (error) {
            const summary = errorSummary(error);
            log(
                `start_robot_browser.js: navigation attempt ${attempt}/${maxAttempts} failed: ${summary}`,
            );
            if (shouldLogFullError(attempt, maxAttempts)) log(error);
            if (attempt === maxAttempts) throw error;

            await sleep(
                retryDelayMs(attempt, initialDelayMs, maxDelayMs),
            );
        }
    }
}

module.exports = {
    DEFAULT_MAX_CONSOLE_MESSAGE_CHARS,
    errorSummary,
    formatBrowserConsoleMessage,
    isClosedTargetError,
    navigateWithRetry,
    retryDelayMs,
    shouldLogFullError,
    truncateLogMessage,
};
