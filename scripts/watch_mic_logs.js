#!/usr/bin/env node

/**
 * Live watcher utility for Microphone Event Logs.
 * Tails ~/stretch_user/log/web_teleop/mic_events_latest.jsonl
 * with syntax highlighting and pretty formatting.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const chalk = require('chalk');

function resolveLogPath() {
    const defaultDir = path.join(os.homedir(), 'stretch_user', 'log', 'web_teleop');
    const targetDir = process.env.REDIRECT_LOGDIR || defaultDir;
    const latestFile = path.join(targetDir, 'mic_events_latest.jsonl');
    const textRefFile = path.join(targetDir, 'mic_events_latest.jsonl.txt');

    // 1. Direct symlink / file check
    if (fs.existsSync(latestFile)) {
        try {
            return fs.realpathSync(latestFile);
        } catch (_) {
            return latestFile;
        }
    }

    // 2. Check text reference fallback file
    if (fs.existsSync(textRefFile)) {
        try {
            const target = fs.readFileSync(textRefFile, 'utf8').trim();
            if (fs.existsSync(target)) {
                return target;
            }
        } catch (_) {}
    }

    // 3. Fallback: find the newest mic_events_*.jsonl file in targetDir
    if (fs.existsSync(targetDir)) {
        try {
            const files = fs.readdirSync(targetDir)
                .filter((f) => f.startsWith('mic_events_') && f.endsWith('.jsonl') && f !== 'mic_events_latest.jsonl')
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

function formatAndPrintLine(line) {
    if (!line || !line.trim()) return;
    try {
        const record = JSON.parse(line.trim());
        const timeShort = record.timestamp ? record.timestamp.slice(11, 19) : '--:--:--';
        const eventName = record.event || 'unknown';

        let eventColor = chalk.cyan;
        let icon = '🎙️ ';
        if (eventName === 'User access granted' || eventName === 'Connected' || eventName === 'Unmuted') {
            eventColor = chalk.green;
            icon = eventName === 'Unmuted' ? '🔊' : '🟢';
        } else if (eventName === 'User access rejected' || eventName === 'Disconnected' || eventName === 'Muted') {
            eventColor = chalk.yellow;
            icon = eventName === 'Muted' ? '🔇' : (eventName === 'Disconnected' ? '🔴' : '🚫');
        }

        const detailsStr = record.details && Object.keys(record.details).length > 0
            ? ` ${chalk.grey(JSON.stringify(record.details))}`
            : '';

        console.log(
            `${chalk.grey(`[MicLog ${timeShort}]`)} ` +
            `${icon}  ${eventColor.bold(eventName)}${detailsStr}`
        );
    } catch (e) {
        console.log(chalk.grey(`[RawLog] ${line.trim()}`));
    }
}

function main() {
    let logPath = resolveLogPath();

    console.log(chalk.bold.cyan('\n======================================================'));
    console.log(chalk.bold.cyan('       STRETCH MICROPHONE EVENTS LIVE WATCHER         '));
    console.log(chalk.bold.cyan('======================================================'));
    console.log(chalk.cyan(`Target Log File: ${logPath}\n`));

    if (!fs.existsSync(logPath)) {
        console.log(chalk.yellow(`Waiting for log file to be created at: ${logPath} ...`));
    }

    let fileSize = 0;
    if (fs.existsSync(logPath)) {
        fileSize = fs.statSync(logPath).size;
        // Read existing content
        const content = fs.readFileSync(logPath, 'utf8');
        const lines = content.split('\n');
        lines.forEach(formatAndPrintLine);
    }

    // Watch for new lines appended to file or new log files created
    let watchTimer = setInterval(() => {
        const currentResolved = resolveLogPath();
        if (currentResolved !== logPath && fs.existsSync(currentResolved)) {
            logPath = currentResolved;
            fileSize = 0;
            console.log(chalk.cyan(`\nSwitched to active log file: ${logPath}\n`));
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
                // File truncated or reset
                fileSize = stats.size;
            }
        } catch (_) {}
    }, 500);

    process.on('SIGINT', () => {
        clearInterval(watchTimer);
        console.log(chalk.grey('\nExiting microphone watcher.\n'));
        process.exit(0);
    });
}

main();
