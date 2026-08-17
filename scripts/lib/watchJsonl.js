const fs = require('fs');
const path = require('path');
const os = require('os');
const chalk = require('chalk');

const BANNER_RULE = '======================================================';
const DEFAULT_POLL_MS = 500;

function webTeleopLogDir() {
    const defaultDir = path.join(os.homedir(), 'stretch_user', 'log', 'web_teleop');
    return process.env.REDIRECT_LOGDIR || defaultDir;
}

function isSessionJsonl(filename, prefixes) {
    return (
        filename.endsWith('.jsonl') &&
        !filename.includes('latest') &&
        prefixes.some((prefix) => filename.startsWith(prefix))
    );
}

/**
 * Resolve the active JSONL log: latest symlink, .txt path fallback, then newest matching file.
 * @param {string} latestName e.g. 'transcribe_model_latest.jsonl'
 * @param {string[]} prefixes session-file prefixes, e.g. ['transcribe_model_']
 */
function resolveLatestJsonl(latestName, prefixes) {
    const targetDir = webTeleopLogDir();
    const latestFile = path.join(targetDir, latestName);
    const textRefFile = `${latestFile}.txt`;

    if (fs.existsSync(latestFile)) {
        try {
            return fs.realpathSync(latestFile);
        } catch (_) {
            return latestFile;
        }
    }

    if (fs.existsSync(textRefFile)) {
        try {
            const target = fs.readFileSync(textRefFile, 'utf8').trim();
            if (fs.existsSync(target)) {
                return target;
            }
        } catch (_) {}
    }

    if (fs.existsSync(targetDir)) {
        try {
            const files = fs.readdirSync(targetDir)
                .filter((f) => isSessionJsonl(f, prefixes))
                .map((f) => ({
                    path: path.join(targetDir, f),
                    mtime: fs.statSync(path.join(targetDir, f)).mtimeMs,
                }))
                .sort((a, b) => b.mtime - a.mtime);

            if (files.length > 0) {
                return files[0].path;
            }
        } catch (_) {}
    }

    return latestFile;
}

/**
 * Print a banner, dump existing lines, then tail the resolved JSONL path.
 * @param {{
 *   latestName: string,
 *   prefixes: string[],
 *   title: string,
 *   titleColor: (s: string) => string,
 *   switchColor?: (s: string) => string,
 *   formatAndPrintLine: (line: string) => void,
 *   exitLabel: string,
 *   pollMs?: number,
 * }} opts
 */
function watchJsonl(opts) {
    const {
        latestName,
        prefixes,
        title,
        titleColor,
        switchColor = opts.titleColor,
        formatAndPrintLine,
        exitLabel,
        pollMs = DEFAULT_POLL_MS,
    } = opts;

    const resolvePath = () => resolveLatestJsonl(latestName, prefixes);
    let logPath = resolvePath();

    console.log(titleColor(`\n${BANNER_RULE}`));
    console.log(titleColor(title));
    console.log(titleColor(BANNER_RULE));
    console.log(chalk.grey(`Target Log File: ${logPath}\n`));

    if (!fs.existsSync(logPath)) {
        console.log(chalk.yellow(`Waiting for log file to be created at: ${logPath} ...`));
    }

    let fileSize = 0;
    if (fs.existsSync(logPath)) {
        fileSize = fs.statSync(logPath).size;
        fs.readFileSync(logPath, 'utf8').split('\n').forEach(formatAndPrintLine);
    }

    const watchTimer = setInterval(() => {
        const currentResolved = resolvePath();
        if (currentResolved !== logPath && fs.existsSync(currentResolved)) {
            logPath = currentResolved;
            fileSize = 0;
            console.log(switchColor(`\nSwitched to active log file: ${logPath}\n`));
        }

        if (!fs.existsSync(logPath)) return;
        try {
            const stats = fs.statSync(logPath);
            if (stats.size > fileSize) {
                const stream = fs.createReadStream(logPath, {
                    start: fileSize,
                    end: stats.size,
                    encoding: 'utf8',
                });
                fileSize = stats.size;
                stream.on('data', (chunk) => {
                    chunk.split('\n').forEach(formatAndPrintLine);
                });
            } else if (stats.size < fileSize) {
                fileSize = stats.size;
            }
        } catch (_) {}
    }, pollMs);

    process.on('SIGINT', () => {
        clearInterval(watchTimer);
        console.log(chalk.grey(`\nExiting ${exitLabel}.\n`));
        process.exit(0);
    });
}

module.exports = {
    resolveLatestJsonl,
    watchJsonl,
    webTeleopLogDir,
};
