#!/usr/bin/env node

/**
 * Live watcher utility for Realtime Model Logs (Reasoning & Tools: gpt-realtime-2.1).
 * Tails ~/stretch_user/log/web_teleop/realtime_model_latest.jsonl
 * with syntax highlighting and pretty formatting.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const chalk = require('chalk');

function resolveLogPath() {
    const defaultDir = path.join(os.homedir(), 'stretch_user', 'log', 'web_teleop');
    const targetDir = process.env.REDIRECT_LOGDIR || defaultDir;
    const latestFile = path.join(targetDir, 'realtime_model_latest.jsonl');
    const textRefFile = path.join(targetDir, 'realtime_model_latest.jsonl.txt');

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

    // 3. Fallback: find the newest realtime_model_*.jsonl or voice_interactions_*.jsonl file in targetDir
    if (fs.existsSync(targetDir)) {
        try {
            const files = fs.readdirSync(targetDir)
                .filter((f) => (f.startsWith('realtime_model_') || f.startsWith('voice_interactions_')) && f.endsWith('.jsonl') && !f.includes('latest'))
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

        // 1. Tool / System console log entry
        if (record.message || record.type === 'log' || record.type === 'tool') {
            const msg = record.message || '';
            let formatted = msg;
            if (msg.includes('Tool') || msg.includes('result')) {
                formatted = `🛠️  ${chalk.yellow(msg)}`;
            } else if (msg.includes('error') || msg.includes('fail')) {
                formatted = `⚠️  ${chalk.red(msg)}`;
            } else {
                formatted = `💬 ${chalk.white(msg)}`;
            }

            console.log(`${chalk.grey(`[RealtimeModel ${timeShort}]`)} ${formatted}`);
            return;
        }

        // 2. Structured voice interaction & tool decision record
        const transcriptText = record.input?.transcript ? `"${record.input.transcript}"` : '(context)';
        const toolText = record.output?.tool_name
            ? `${record.output.tool_name}(${JSON.stringify(record.output.tool_args || {})})`
            : '(no tool call)';
        const statusIcon = record.execution?.success ? chalk.green('✅ SUCCESS') : chalk.red('❌ REJECTED');
        const detailText = record.execution?.detail ? ` (${record.execution.detail})` : '';

        console.log(
            `${chalk.grey(`[RealtimeModel ${timeShort}]`)} ` +
            `🗣️  ${chalk.cyan(transcriptText)} ➔ ` +
            `🛠️  ${chalk.yellow.bold(toolText)} ➔ ` +
            `${statusIcon}${chalk.grey(detailText)}`
        );
    } catch (e) {
        console.log(chalk.grey(`[RawRealtimeLog] ${line.trim()}`));
    }
}

function main() {
    let logPath = resolveLogPath();

    console.log(chalk.bold.yellow('\n======================================================'));
    console.log(chalk.bold.yellow('    REALTIME MODEL LIVE STREAM (gpt-realtime-2.1)     '));
    console.log(chalk.bold.yellow('======================================================'));
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
            console.log(chalk.yellow(`\nSwitched to active log file: ${logPath}\n`));
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
        console.log(chalk.grey('\nExiting realtime model watcher.\n'));
        process.exit(0);
    });
}

main();
