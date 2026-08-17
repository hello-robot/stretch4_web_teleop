#!/usr/bin/env node

/**
 * Live watcher utility for Microphone Event Logs.
 * Tails ~/stretch_user/log/web_teleop/mic_events_latest.jsonl
 * with syntax highlighting and pretty formatting.
 */

const chalk = require('chalk');
const { watchJsonl } = require('./lib/watchJsonl');

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

watchJsonl({
    latestName: 'mic_events_latest.jsonl',
    prefixes: ['mic_events_'],
    title: '       STRETCH MICROPHONE EVENTS LIVE WATCHER         ',
    titleColor: chalk.bold.cyan,
    switchColor: chalk.cyan,
    formatAndPrintLine,
    exitLabel: 'microphone watcher',
});
