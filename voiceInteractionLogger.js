const fs = require('fs');
const path = require('path');
const os = require('os');
const chalk = require('chalk');

let currentLogFile = null;
let latestSymlinkPath = null;
let sseClients = [];
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
 * Initializes the Voice Interaction Logger
 * Sets up log files, SSE endpoints, and socket handlers.
 */
function initVoiceInteractionLogger(app, io) {
    const logDir = getLogDir();
    const ts = getTimestampString();
    sessionId = `session_${ts}`;
    currentLogFile = path.join(logDir, `voice_interactions_${ts}.jsonl`);
    latestSymlinkPath = path.join(logDir, `voice_interactions_latest.jsonl`);

    // Create / update symlink to latest log file
    try {
        if (fs.existsSync(latestSymlinkPath)) {
            fs.unlinkSync(latestSymlinkPath);
        }
        fs.symlinkSync(currentLogFile, latestSymlinkPath);
    } catch (e) {
        // Fallback for Windows or systems without symlink permissions: write path reference
        try {
            fs.writeFileSync(latestSymlinkPath + '.txt', currentLogFile, 'utf8');
        } catch (_) {}
    }

    console.log(chalk.cyan(`[VoiceInteractionLogger] Logging interactions to: ${currentLogFile}`));

    // Register HTTP endpoint for live SSE stream
    if (app) {
        app.get('/voice-logs/stream', (req, res) => {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.flushHeaders();

            const client = { id: Date.now(), res };
            sseClients.push(client);

            // Send initial connection event
            res.write(`event: connected\ndata: ${JSON.stringify({ sessionId, currentLogFile })}\n\n`);

            req.on('close', () => {
                sseClients = sseClients.filter((c) => c.id !== client.id);
            });
        });

        // Register HTTP endpoint to fetch latest log file contents
        app.get('/voice-logs/latest', (req, res) => {
            if (!currentLogFile || !fs.existsSync(currentLogFile)) {
                return res.status(404).json({ error: 'No voice interaction log file available.' });
            }
            res.sendFile(currentLogFile);
        });
    }

    // Register Socket.IO handler for incoming interaction records
    if (io) {
        io.on('connection', (socket) => {
            socket.on('voice_interaction', (data) => {
                logVoiceInteraction(data);
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

    const record = {
        timestamp: isoTimestamp,
        session_id: sessionId || `session_${getTimestampString(now)}`,
        fleet_id: process.env.HELLO_FLEET_ID || 'unknown',
        listening_state: data.listening_state || 'unknown',
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

    const jsonLine = JSON.stringify(record) + '\n';

    // 1. Asynchronously write to disk
    if (currentLogFile) {
        fs.appendFile(currentLogFile, jsonLine, (err) => {
            if (err) {
                console.error(chalk.red(`[VoiceInteractionLogger] Failed to write log: ${err.message}`));
            }
        });
    }

    // 2. Colorized stdout logging for PM2 / terminal
    const timeShort = isoTimestamp.slice(11, 19);
    const transcriptText = record.input.transcript ? `"${record.input.transcript}"` : '(no transcript)';
    const toolText = record.output.tool_name ? `${record.output.tool_name}(${JSON.stringify(record.output.tool_args)})` : '(no tool)';
    const statusIcon = record.execution.success ? chalk.green('✅ SUCCESS') : chalk.red('❌ REJECTED');

    console.log(
        `${chalk.grey(`[VoiceLog ${timeShort}]`)} ` +
        `🗣️  ${chalk.cyan(transcriptText)} ➔ ` +
        `🛠️  ${chalk.yellow(toolText)} ➔ ` +
        `${statusIcon} ${chalk.grey(`(${record.execution.detail})`)}`
    );

    // 3. Broadcast to live SSE clients
    const sseEvent = `event: interaction\ndata: ${JSON.stringify(record)}\n\n`;
    for (const client of sseClients) {
        try {
            client.res.write(sseEvent);
        } catch (_) {
            // Client connection closed
        }
    }
}

module.exports = {
    initVoiceInteractionLogger,
    logVoiceInteraction,
};
