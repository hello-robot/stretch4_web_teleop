#!/usr/bin/env node

/**
 * Live watcher utility for Transcribe Model Logs (STT: gpt-4o-transcribe).
 * Tails ~/stretch_user/log/web_teleop/transcribe_model_latest.jsonl
 * with syntax highlighting and pretty formatting.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const chalk = require('chalk');

function resolveLogPath() {
    const defaultDir = path.join(os.homedir(), 'stretch_user', 'log', 'web_teleop');
    const targetDir = process.env.REDIRECT_LOGDIR || defaultDir;
    const latestFile = path.join(targetDir, 'transcribe_model_latest.jsonl');
    const textRefFile = path.join(targetDir, 'transcribe_model_latest.jsonl.txt');

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

    // 3. Fallback: find the newest transcribe_model_*.jsonl file in targetDir
    if (fs.existsSync(targetDir)) {
        try {
            const files = fs.readdirSync(targetDir)
                .filter((f) => f.startsWith('transcribe_model_') && f.endsWith('.jsonl') && f !== 'transcribe_model_latest.jsonl')
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
        const type = record.type || 'transcript';

        if (type === 'partial') {
            const text = record.message || record.transcript || '';
            console.log(
                `${chalk.grey(`[TranscribeModel ${timeShort}]`)} ` +
                `🗣️  ${chalk.grey('(partial)')} ${chalk.cyan(text)}`
            );
        } else if (type === 'final' || record.transcript) {
            const text = record.transcript || record.message || '';
            console.log(
                `${chalk.grey(`[TranscribeModel ${timeShort}]`)} ` +
                `🗣️  ${chalk.cyan.bold(`"${text}"`)}`
            );
        } else if (type === 'wake_sleep' || (record.message && record.message.includes('[WakeSleep]'))) {
            const text = record.message || record.transcript || '';
            console.log(
                `${chalk.grey(`[TranscribeModel ${timeShort}]`)} ` +
                `⏰ ${chalk.magenta.bold(text)}`
            );
        } else {
            console.log(
                `${chalk.grey(`[TranscribeModel ${timeShort}]`)} ` +
                `🗣️  ${chalk.cyan(record.message || JSON.stringify(record))}`
            );
        }
    } catch (e) {
        console.log(chalk.grey(`[RawTranscribeLog] ${line.trim()}`));
    }
}

function main() {
    let logPath = resolveLogPath();

    console.log(chalk.bold.cyan('\n======================================================'));
    console.log(chalk.bold.cyan('   TRANSCRIBE MODEL LIVE STREAM (gpt-4o-transcribe)   '));
    console.log(chalk.bold.cyan('======================================================'));
    console.log(chalk.grey(`Target Log File: ${logPath}\n`));

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
        console.log(chalk.grey('\nExiting transcribe model watcher.\n'));
        process.exit(0);
    });
}

main();
