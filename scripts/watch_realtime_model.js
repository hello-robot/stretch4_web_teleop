#!/usr/bin/env node

/**
 * Live watcher utility for Realtime Model Logs (Reasoning & Tools: gpt-realtime-2.1).
 * Tails ~/stretch_user/log/web_teleop/realtime_model_latest.jsonl
 * with syntax highlighting and pretty formatting.
 */

const chalk = require('chalk');
const { watchJsonl } = require('./lib/watchJsonl');

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
            `${statusIcon}${chalk.grey(detailText)}` +
            (record.audio_file ? chalk.grey(` 🎧 ${record.audio_file}`) : '')
        );
    } catch (e) {
        console.log(chalk.grey(`[RawRealtimeLog] ${line.trim()}`));
    }
}

watchJsonl({
    latestName: 'realtime_model_latest.jsonl',
    prefixes: ['realtime_model_', 'voice_interactions_'],
    title: '    REALTIME MODEL LIVE STREAM (gpt-realtime-2.1)     ',
    titleColor: chalk.bold.yellow,
    switchColor: chalk.yellow,
    formatAndPrintLine,
    exitLabel: 'realtime model watcher',
});
