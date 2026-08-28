#!/usr/bin/env node

/**
 * Live watcher utility for Transcribe Model Logs (STT: gpt-4o-transcribe).
 * Tails ~/stretch_user/log/web_teleop/transcribe_model_latest.jsonl
 * with syntax highlighting and pretty formatting.
 */

const chalk = require('chalk');
const { watchJsonl } = require('./lib/watchJsonl');

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
            const audioHint = record.audio_file
                ? chalk.grey(` 🎧 ${record.audio_file}`)
                : '';
            console.log(
                `${chalk.grey(`[TranscribeModel ${timeShort}]`)} ` +
                `🗣️  ${chalk.cyan.bold(`"${text}"`)}${audioHint}`
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

watchJsonl({
    latestName: 'transcribe_model_latest.jsonl',
    prefixes: ['transcribe_model_'],
    title: '   TRANSCRIBE MODEL LIVE STREAM (gpt-4o-transcribe)   ',
    titleColor: chalk.bold.cyan,
    switchColor: chalk.cyan,
    formatAndPrintLine,
    exitLabel: 'transcribe model watcher',
});
