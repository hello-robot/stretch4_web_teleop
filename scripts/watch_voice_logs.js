#!/usr/bin/env node

/**
 * Live watcher utility for Voice Interaction Logs.
 * Tails ~/stretch_user/log/web_teleop/voice_interactions_latest.jsonl
 * with syntax highlighting and pretty formatting.
 */

const chalk = require('chalk');
const { watchJsonl } = require('./lib/watchJsonl');

function formatAndPrintLine(line) {
    if (!line || !line.trim()) return;
    try {
        const record = JSON.parse(line.trim());
        const timeShort = record.timestamp ? record.timestamp.slice(11, 19) : '--:--:--';

        // 1. General VoiceCommandAssistant log entry
        if (record.message || record.type === 'log') {
            const msg = record.message || '';
            let formatted = msg;
            if (msg.includes('user transcript (partial):')) {
                const text = msg.replace(/.*user transcript \(partial\):\s*/, '');
                formatted = `🗣️  ${chalk.grey('(partial)')} ${chalk.cyan(text)}`;
            } else if (msg.includes('user transcript:')) {
                const text = msg.replace(/.*user transcript:\s*/, '');
                formatted = `🗣️  ${chalk.cyan.bold(`"${text}"`)}`;
            } else if (msg.includes('[WakeSleep]')) {
                formatted = `⏰ ${chalk.magenta(msg)}`;
            } else if (msg.includes('Tool') || msg.includes('result')) {
                formatted = `🛠️  ${chalk.yellow(msg)}`;
            } else {
                formatted = `💬 ${chalk.white(msg)}`;
            }

            console.log(`${chalk.grey(`[VoiceLog ${timeShort}]`)} ${formatted}`);
            return;
        }

        // 2. Structured voice interaction summary record
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

watchJsonl({
    latestName: 'voice_interactions_latest.jsonl',
    prefixes: ['voice_interactions_'],
    title: '       STRETCH VOICE INTERACTION LIVE WATCHER         ',
    titleColor: chalk.bold.magenta,
    switchColor: chalk.cyan,
    formatAndPrintLine,
    exitLabel: 'voice watcher',
});
