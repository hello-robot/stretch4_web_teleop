#!/usr/bin/env node

/**
 * Live watcher utility for Voice Interaction Logs.
 * Tails ~/stretch_user/log/web_teleop/voice_interactions_latest.jsonl
 * with syntax highlighting and pretty formatting.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const chalk = require('chalk');

function resolveLogPath() {
    const defaultDir = path.join(os.homedir(), 'stretch_user', 'log', 'web_teleop');
    const targetDir = process.env.REDIRECT_LOGDIR || defaultDir;
    const latestFile = path.join(targetDir, 'voice_interactions_latest.jsonl');
    return latestFile;
}

function formatAndPrintLine(line) {
    if (!line || !line.trim()) return;
    try {
        const record = JSON.parse(line.trim());
        const timeShort = record.timestamp ? record.timestamp.slice(11, 19) : '--:--:--';
        const transcriptText = record.input?.transcript ? `"${record.input.transcript}"` : '(no transcript)';
        const toolText = record.output?.tool_name
            ? `${record.output.tool_name}(${JSON.stringify(record.output.tool_args || {})})`
            : '(no tool)';
        const statusIcon = record.execution?.success ? chalk.green('✅ SUCCESS') : chalk.red('❌ REJECTED');
        const detailText = record.execution?.detail ? ` (${record.execution.detail})` : '';

        console.log(
            `${chalk.grey(`[VoiceLog ${timeShort}]`)} ` +
            `🗣️  ${chalk.cyan.bold(transcriptText)} ➔ ` +
            `🛠️  ${chalk.yellow(toolText)} ➔ ` +
            `${statusIcon}${chalk.grey(detailText)}`
        );
    } catch (e) {
        console.log(chalk.grey(`[RawLog] ${line.trim()}`));
    }
}

function main() {
    const logPath = resolveLogPath();

    console.log(chalk.bold.magenta('\n======================================================'));
    console.log(chalk.bold.magenta('       STRETCH VOICE INTERACTION LIVE WATCHER         '));
    console.log(chalk.bold.magenta('======================================================'));
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

    // Watch for new lines appended to file
    let watchTimer = setInterval(() => {
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
        console.log(chalk.grey('\nExiting voice watcher.\n'));
        process.exit(0);
    });
}

main();
