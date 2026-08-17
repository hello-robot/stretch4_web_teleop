const fs = require('fs');
const path = require('path');
const os = require('os');
const chalk = require('chalk');

let currentTranscribeLogFile = null;
let latestTranscribeSymlinkPath = null;
let currentRealtimeLogFile = null;
let latestRealtimeSymlinkPath = null;
let legacyLatestSymlinkPath = null;
let currentMicLogFile = null;
let latestMicSymlinkPath = null;

let transcribeSseClients = [];
let realtimeSseClients = [];
let micSseClients = [];
let sessionId = null;

/**
 * Formats a date object to YYYYMMDD_HHMMSS
 */
function getTimestampString(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const yyyy = date.getFullYear();
    const mm = pad(date.getMonth() + 1);
    const dd = pad(date.getDate());
    const hh = pad(date.getHours());
    const min = pad(date.getMinutes());
    const ss = pad(date.getSeconds());
    return `${yyyy}${mm}${dd}_${hh}${mm}${ss}`;
}

/**
 * Resolves the log directory path
 */
function getLogDir() {
    if (process.env.REDIRECT_LOGDIR && fs.existsSync(process.env.REDIRECT_LOGDIR)) {
        return process.env.REDIRECT_LOGDIR;
    }
    const userLogDir = path.join(os.homedir(), 'stretch_user', 'log', 'web_teleop');
    if (!fs.existsSync(userLogDir)) {
        fs.mkdirSync(userLogDir, { recursive: true });
    }
    return userLogDir;
}

/**
 * Helper to create or update a symlink with fallback
 */
function createOrUpdateSymlink(targetFile, symlinkPath) {
    try {
        // Touch target file to make sure it exists
        if (!fs.existsSync(targetFile)) {
            try {
                fs.writeFileSync(targetFile, '', { flag: 'a' });
            } catch (_) {}
        }
        // Unlink any existing or broken symlink
        try {
            fs.unlinkSync(symlinkPath);
        } catch (_) {}
        fs.symlinkSync(targetFile, symlinkPath);
    } catch (e) {
        try {
            fs.writeFileSync(symlinkPath + '.txt', targetFile, 'utf8');
        } catch (_) {}
    }
}

/**
 * Initializes the Voice Interaction Logger and Mic Event Logger
 * Sets up log files, SSE endpoints, and socket handlers.
 */
function initVoiceInteractionLogger(app, io) {
    const logDir = getLogDir();
    const ts = getTimestampString();
    sessionId = `session_${ts}`;

    // Model 1: Speech-to-Text Transcribe Model (gpt-4o-transcribe)
    currentTranscribeLogFile = path.join(logDir, `transcribe_model_${ts}.jsonl`);
    latestTranscribeSymlinkPath = path.join(logDir, `transcribe_model_latest.jsonl`);
    createOrUpdateSymlink(currentTranscribeLogFile, latestTranscribeSymlinkPath);

    // Model 2: Realtime Reasoning & Tool Model (gpt-realtime-2.1)
    currentRealtimeLogFile = path.join(logDir, `realtime_model_${ts}.jsonl`);
    latestRealtimeSymlinkPath = path.join(logDir, `realtime_model_latest.jsonl`);
    legacyLatestSymlinkPath = path.join(logDir, `voice_interactions_latest.jsonl`);
    createOrUpdateSymlink(currentRealtimeLogFile, latestRealtimeSymlinkPath);
    createOrUpdateSymlink(currentRealtimeLogFile, legacyLatestSymlinkPath);

    // Mic Events Logger
    currentMicLogFile = path.join(logDir, `mic_events_${ts}.jsonl`);
    latestMicSymlinkPath = path.join(logDir, `mic_events_latest.jsonl`);
    createOrUpdateSymlink(currentMicLogFile, latestMicSymlinkPath);

    console.log(chalk.cyan(`[VoiceInteractionLogger] Logging Transcribe Model to: ${currentTranscribeLogFile}`));
    console.log(chalk.cyan(`[VoiceInteractionLogger] Logging Realtime Model to: ${currentRealtimeLogFile}`));
    console.log(chalk.cyan(`[VoiceInteractionLogger] Logging Mic events to: ${currentMicLogFile}`));

    // Register HTTP endpoints for live SSE streams and latest files
    if (app) {
        // Transcribe Model SSE & Latest Endpoints
        app.get('/transcribe-model-logs/stream', (req, res) => {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.flushHeaders();

            const client = { id: Date.now(), res };
            transcribeSseClients.push(client);
            res.write(`event: connected\ndata: ${JSON.stringify({ sessionId, logFile: currentTranscribeLogFile, model: 'gpt-4o-transcribe' })}\n\n`);

            req.on('close', () => {
                transcribeSseClients = transcribeSseClients.filter((c) => c.id !== client.id);
            });
        });

        app.get('/transcribe-model-logs/latest', (req, res) => {
            if (!currentTranscribeLogFile || !fs.existsSync(currentTranscribeLogFile)) {
                return res.status(404).json({ error: 'No transcribe model log file available.' });
            }
            res.sendFile(currentTranscribeLogFile);
        });

        // Realtime Model SSE & Latest Endpoints (and legacy /voice-logs)
        const handleRealtimeStream = (req, res) => {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.flushHeaders();

            const client = { id: Date.now(), res };
            realtimeSseClients.push(client);
            res.write(`event: connected\ndata: ${JSON.stringify({ sessionId, logFile: currentRealtimeLogFile, model: 'gpt-realtime-2.1' })}\n\n`);

            req.on('close', () => {
                realtimeSseClients = realtimeSseClients.filter((c) => c.id !== client.id);
            });
        };

        app.get('/realtime-model-logs/stream', handleRealtimeStream);
        app.get('/voice-logs/stream', handleRealtimeStream);

        const handleRealtimeLatest = (req, res) => {
            if (!currentRealtimeLogFile || !fs.existsSync(currentRealtimeLogFile)) {
                return res.status(404).json({ error: 'No realtime model log file available.' });
            }
            res.sendFile(currentRealtimeLogFile);
        };

        app.get('/realtime-model-logs/latest', handleRealtimeLatest);
        app.get('/voice-logs/latest', handleRealtimeLatest);

        // Mic Logs SSE & Latest Endpoints
        app.get('/mic-logs/stream', (req, res) => {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.flushHeaders();

            const client = { id: Date.now(), res };
            micSseClients.push(client);
            res.write(`event: connected\ndata: ${JSON.stringify({ sessionId, currentMicLogFile })}\n\n`);

            req.on('close', () => {
                micSseClients = micSseClients.filter((c) => c.id !== client.id);
            });
        });

        app.get('/mic-logs/latest', (req, res) => {
            if (!currentMicLogFile || !fs.existsSync(currentMicLogFile)) {
                return res.status(404).json({ error: 'No mic events log file available.' });
            }
            res.sendFile(currentMicLogFile);
        });
    }

    // Socket.io integration
    if (io) {
        io.on('connection', (socket) => {
            socket.on('voice_interaction', (data) => {
                try {
                    logVoiceInteraction(data);
                } catch (err) {
                    console.error('[VoiceInteractionLogger] Error processing voice_interaction:', err);
                }
            });

            socket.on('mic_event', (data) => {
                try {
                    logMicEvent(data);
                } catch (err) {
                    console.error('[VoiceInteractionLogger] Error processing mic_event:', err);
                }
            });

            socket.on('voice_assistant_log', (data) => {
                try {
                    logVoiceAssistantLog(data);
                } catch (err) {
                    console.error('[VoiceInteractionLogger] Error processing voice_assistant_log:', err);
                }
            });
        });
    }
}

/**
 * Logs a single voice interaction record to disk, stdout, and live SSE stream.
 */
function logVoiceInteraction(data) {
    if (!data) return;

    const now = new Date();
    const isoTimestamp = now.toISOString();

    // 1. If transcript is present, log to Transcribe Model stream
    if (data.transcript) {
        const transcribeRecord = {
            type: 'final',
            timestamp: isoTimestamp,
            session_id: sessionId || `session_${getTimestampString(now)}`,
            fleet_id: process.env.HELLO_FLEET_ID || 'unknown',
            model: data.stt_model || 'gpt-4o-transcribe',
            transcript: data.transcript,
            listening_state: data.listening_state || 'unknown',
        };

        if (currentTranscribeLogFile) {
            fs.appendFile(currentTranscribeLogFile, JSON.stringify(transcribeRecord) + '\n', (err) => {
                if (err) console.error(chalk.red(`[VoiceInteractionLogger] Transcribe write failed: ${err.message}`));
            });
        }

        const sseEvent = `event: transcript\ndata: ${JSON.stringify(transcribeRecord)}\n\n`;
        for (const client of transcribeSseClients) {
            try { client.res.write(sseEvent); } catch (_) {}
        }
    }

    // 2. Log reasoning, tool call and outcome to Realtime Model stream
    const realtimeRecord = {
        type: 'interaction',
        timestamp: isoTimestamp,
        session_id: sessionId || `session_${getTimestampString(now)}`,
        fleet_id: process.env.HELLO_FLEET_ID || 'unknown',
        listening_state: data.listening_state || 'unknown',
        model: data.reasoning_model || 'gpt-realtime-2.1',
        input: {
            transcript: data.transcript || '',
            stt_model: data.stt_model || 'gpt-4o-transcribe',
        },
        output: {
            tool_name: data.tool_name || '',
            tool_args: data.tool_args || {},
            reasoning_model: data.reasoning_model || 'gpt-realtime-2.1',
        },
        execution: {
            success: Boolean(data.success),
            detail: data.detail || '',
            execution_mode: data.execution_mode || 'button_provider',
        },
    };

    if (currentRealtimeLogFile) {
        fs.appendFile(currentRealtimeLogFile, JSON.stringify(realtimeRecord) + '\n', (err) => {
            if (err) console.error(chalk.red(`[VoiceInteractionLogger] Realtime write failed: ${err.message}`));
        });
    }

    // Colorized stdout logging
    const timeShort = isoTimestamp.slice(11, 19);
    const transcriptText = realtimeRecord.input.transcript ? `"${realtimeRecord.input.transcript}"` : '(no transcript)';
    const toolText = realtimeRecord.output.tool_name ? `${realtimeRecord.output.tool_name}(${JSON.stringify(realtimeRecord.output.tool_args)})` : '(no tool)';
    const statusIcon = realtimeRecord.execution.success ? chalk.green('✅ SUCCESS') : chalk.red('❌ REJECTED');

    console.log(
        `${chalk.grey(`[RealtimeModel ${timeShort}]`)} ` +
        `🗣️  ${chalk.cyan(transcriptText)} ➔ ` +
        `🛠️  ${chalk.yellow(toolText)} ➔ ` +
        `${statusIcon} ${chalk.grey(`(${realtimeRecord.execution.detail})`)}`
    );

    const sseEvent = `event: interaction\ndata: ${JSON.stringify(realtimeRecord)}\n\n`;
    for (const client of realtimeSseClients) {
        try { client.res.write(sseEvent); } catch (_) {}
    }
}

/**
 * Logs a single microphone lifecycle/health event to disk, stdout, and live SSE stream.
 */
function logMicEvent(data) {
    if (!data) return;

    const now = new Date();
    const isoTimestamp = now.toISOString();

    const record = {
        timestamp: isoTimestamp,
        session_id: sessionId || `session_${getTimestampString(now)}`,
        fleet_id: process.env.HELLO_FLEET_ID || 'unknown',
        event: data.event || 'unknown',
        details: data.details || {},
    };

    const jsonLine = JSON.stringify(record) + '\n';

    if (currentMicLogFile) {
        fs.appendFile(currentMicLogFile, jsonLine, (err) => {
            if (err) console.error(chalk.red(`[VoiceInteractionLogger] Failed to write mic log: ${err.message}`));
        });
    }

    const timeShort = isoTimestamp.slice(11, 19);
    let eventColor = chalk.cyan;
    let icon = '🎙️ ';
    if (record.event === 'User access granted' || record.event === 'Connected' || record.event === 'Unmuted') {
        eventColor = chalk.green;
        icon = record.event === 'Unmuted' ? '🔊' : '🟢';
    } else if (record.event === 'User access rejected' || record.event === 'Disconnected' || record.event === 'Muted') {
        eventColor = chalk.yellow;
        icon = record.event === 'Muted' ? '🔇' : (record.event === 'Disconnected' ? '🔴' : '🚫');
    }

    console.log(
        `${chalk.grey(`[MicLog ${timeShort}]`)} ` +
        `${icon}  Mic Event: ${eventColor.bold(record.event)}`
    );

    const sseEvent = `event: mic_event\ndata: ${JSON.stringify(record)}\n\n`;
    for (const client of micSseClients) {
        try { client.res.write(sseEvent); } catch (_) {}
    }
}

/**
 * Logs VoiceCommandAssistant live logs, dynamically routing between Transcribe Model and Realtime Model.
 */
function logVoiceAssistantLog(data) {
    if (!data) return;

    const now = new Date();
    const isoTimestamp = now.toISOString();
    const message = typeof data === 'string' ? data : (data.log || data.message || '');
    const timeShort = isoTimestamp.slice(11, 19);

    // Check if message belongs to Transcribe Model (STT, deltas, transcripts, wake/sleep)
    const isTranscribeLog =
        message.includes('user transcript') ||
        message.includes('[WakeSleep]') ||
        message.includes('transcription');

    if (isTranscribeLog) {
        let type = 'log';
        let text = message;
        if (message.includes('user transcript (partial):')) {
            type = 'partial';
            text = message.replace(/.*user transcript \(partial\):\s*/, '');
        } else if (message.includes('user transcript:')) {
            type = 'final';
            text = message.replace(/.*user transcript:\s*/, '');
        } else if (message.includes('[WakeSleep]')) {
            type = 'wake_sleep';
        }

        const record = {
            type,
            model: 'gpt-4o-transcribe',
            timestamp: isoTimestamp,
            session_id: sessionId || `session_${getTimestampString(now)}`,
            fleet_id: process.env.HELLO_FLEET_ID || 'unknown',
            message: text,
        };

        if (currentTranscribeLogFile) {
            fs.appendFile(currentTranscribeLogFile, JSON.stringify(record) + '\n', (err) => {
                if (err) console.error(chalk.red(`[VoiceInteractionLogger] Transcribe log write failed: ${err.message}`));
            });
        }

        let formatted = text;
        if (type === 'partial') {
            formatted = `🗣️  ${chalk.grey('(partial)')} ${chalk.cyan(text)}`;
        } else if (type === 'final') {
            formatted = `🗣️  ${chalk.cyan.bold(`"${text}"`)}`;
        } else if (type === 'wake_sleep') {
            formatted = `⏰ ${chalk.magenta(message)}`;
        }

        console.log(`${chalk.grey(`[TranscribeModel ${timeShort}]`)} ${formatted}`);

        const sseEvent = `event: transcribe_log\ndata: ${JSON.stringify(record)}\n\n`;
        for (const client of transcribeSseClients) {
            try { client.res.write(sseEvent); } catch (_) {}
        }
    } else {
        // Realtime Model log (tools, responses, reasoning, connections)
        let type = 'log';
        if (message.includes('Tool') || message.includes('result')) {
            type = 'tool';
        }

        const record = {
            type,
            model: 'gpt-realtime-2.1',
            timestamp: isoTimestamp,
            session_id: sessionId || `session_${getTimestampString(now)}`,
            fleet_id: process.env.HELLO_FLEET_ID || 'unknown',
            message: message,
        };

        if (currentRealtimeLogFile) {
            fs.appendFile(currentRealtimeLogFile, JSON.stringify(record) + '\n', (err) => {
                if (err) console.error(chalk.red(`[VoiceInteractionLogger] Realtime log write failed: ${err.message}`));
            });
        }

        let formatted = message;
        if (type === 'tool') {
            formatted = `🛠️  ${chalk.yellow(message)}`;
        } else {
            formatted = `💬 ${chalk.white(message)}`;
        }

        console.log(`${chalk.grey(`[RealtimeModel ${timeShort}]`)} ${formatted}`);

        const sseEvent = `event: realtime_log\ndata: ${JSON.stringify(record)}\n\n`;
        for (const client of realtimeSseClients) {
            try { client.res.write(sseEvent); } catch (_) {}
        }
    }
}

module.exports = {
    initVoiceInteractionLogger,
    logVoiceInteraction,
    logVoiceAssistantLog,
    logMicEvent,
};
