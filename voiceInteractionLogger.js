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
 * Per-operator clip namespace (hex). HTTP GET and uploads only use this dir,
 * so a later operator cannot read or overwrite a previous operator's .ogg files.
 * Cleared on operator disconnect. Distinct from JSONL `sessionId` (process lifetime).
 */
let clipSessionId = null;

/** Cached dynamic import of @audio/encode-opus (ESM). */
let encodeOpusFactoryPromise = null;

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

function isLogSvcEnabled() {
    return process.env.LOG_SVC === '1';
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
 * Stable voice-audio dir (not the launch timestamp folder). Never auto-purged.
 */
function getVoiceAudioDir() {
    const dir = path.join(os.homedir(), 'stretch_user', 'log', 'web_teleop', 'voice_audio');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

/** Safe filename stem from Realtime item_id (path-traversal safe). */
function sanitizeItemId(itemId) {
    if (typeof itemId !== 'string') {
        return '';
    }
    const cleaned = itemId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
    return cleaned;
}

function sanitizeClipSessionId(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) {
        return '';
    }
    return id;
}

/**
 * Bind clip HTTP/upload to the current operator. Pass a 32-char hex id on join;
 * pass null/undefined on disconnect.
 */
function setClipSession(id) {
    if (!id) {
        clipSessionId = null;
        return;
    }
    const safe = sanitizeClipSessionId(id);
    if (!safe) {
        console.warn('[VoiceInteractionLogger] Rejected clip session id');
        clipSessionId = null;
        return;
    }
    clipSessionId = safe;
}

function getClipSessionDir() {
    if (!clipSessionId) {
        return null;
    }
    const dir = path.join(getVoiceAudioDir(), clipSessionId);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

function voiceAudioPathsForItem(itemId) {
    const safe = sanitizeItemId(itemId);
    const dir = getClipSessionDir();
    if (!safe || !dir) {
        return null;
    }
    return {
        item_id: safe,
        clip_session_id: clipSessionId,
        audio_file: path.join(dir, `${safe}.ogg`),
        audio_url: `/voice-audio/${safe}`,
    };
}

function attachAudioFields(record, itemId, audioStartMs, audioEndMs) {
    if (!isLogSvcEnabled() || !itemId) {
        return record;
    }
    const paths = voiceAudioPathsForItem(itemId);
    if (!paths) {
        return record;
    }
    const out = {
        ...record,
        item_id: paths.item_id,
        clip_session_id: paths.clip_session_id,
        audio_file: paths.audio_file,
        audio_url: paths.audio_url,
    };
    if (typeof audioStartMs === 'number') {
        out.audio_start_ms = audioStartMs;
    }
    if (typeof audioEndMs === 'number') {
        out.audio_end_ms = audioEndMs;
    }
    return out;
}

function int16LeToFloat32(pcmBuffer) {
    const buf = Buffer.isBuffer(pcmBuffer)
        ? pcmBuffer
        : Buffer.from(pcmBuffer);
    if (buf.byteLength < 2) {
        return new Float32Array(0);
    }
    const samples = new Int16Array(
        buf.buffer,
        buf.byteOffset,
        Math.floor(buf.byteLength / 2),
    );
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        out[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
    }
    return out;
}

async function getEncodeOpusFactory() {
    if (!encodeOpusFactoryPromise) {
        encodeOpusFactoryPromise = import('@audio/encode-opus').then(
            (mod) => mod.default || mod,
        );
    }
    return encodeOpusFactoryPromise;
}

/**
 * Encode Int16 LE mono PCM → Ogg Opus on disk at the deterministic path.
 */
async function encodeAndWriteVoiceClip(data) {
    if (!isLogSvcEnabled()) {
        return;
    }
    if (!clipSessionId) {
        console.warn('[VoiceInteractionLogger] Rejected voice_audio_clip: no clip session');
        return;
    }
    const paths = voiceAudioPathsForItem(data.item_id);
    if (!paths) {
        console.warn('[VoiceInteractionLogger] Rejected voice_audio_clip: bad item_id');
        return;
    }
    const sampleRate = Number(data.sampleRate) || 16000;
    const pcmRaw = data.pcm;
    if (!pcmRaw) {
        return;
    }
    const floatSamples = int16LeToFloat32(pcmRaw);
    if (floatSamples.length === 0) {
        return;
    }

    const createEncoder = await getEncodeOpusFactory();
    const encoder = await createEncoder({
        sampleRate,
        channels: 1,
        bitrate: 16,
        application: 'voip',
    });
    try {
        const pages = encoder.encode([floatSamples]);
        const tail = encoder.flush();
        const ogg = Buffer.concat([
            Buffer.from(pages),
            Buffer.from(tail),
        ]);
        fs.writeFileSync(paths.audio_file, ogg);
        console.log(
            chalk.cyan(
                `[VoiceInteractionLogger] Wrote uplink Opus clip: ${paths.audio_file} (${ogg.length} bytes)`,
            ),
        );
    } finally {
        try {
            encoder.free();
        } catch (_) {}
    }
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
 * Max Int16 PCM upload size (~1 MiB; covers ~15s @ 16 kHz with headroom).
 */
const MAX_VOICE_CLIP_PCM_BYTES = 1_048_576;

function pcmByteLength(pcm) {
    if (!pcm) {
        return 0;
    }
    if (Buffer.isBuffer(pcm)) {
        return pcm.length;
    }
    if (pcm instanceof ArrayBuffer) {
        return pcm.byteLength;
    }
    if (ArrayBuffer.isView(pcm)) {
        return pcm.byteLength;
    }
    return 0;
}

/**
 * Initializes the Voice Interaction Logger and Mic Event Logger
 * Sets up log files, SSE endpoints, and socket handlers.
 * No-op unless LOG_SVC=1 (--log-svc at launch).
 *
 * @param {import('express').Application} app
 * @param {import('socket.io').Server} io
 * @param {{
 *   getOperatorSocketId?: () => string | undefined,
 *   validateVoiceSession?: (req: import('express').Request) => boolean,
 * }} [opts]
 */
function initVoiceInteractionLogger(app, io, opts = {}) {
    if (!isLogSvcEnabled()) {
        console.log(
            chalk.grey(
                '[VoiceInteractionLogger] Disabled (launch with --log-svc to enable JSONL + uplink Opus clips)',
            ),
        );
        return;
    }

    const getOperatorSocketId = opts.getOperatorSocketId;
    const validateVoiceSession = opts.validateVoiceSession;

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
    console.log(
        chalk.cyan(
            `[VoiceInteractionLogger] SVC uplink recording ON → ${getVoiceAudioDir()}`,
        ),
    );

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

        // Uplink Opus clips (LOG_SVC / --log-svc) — operator voice session required
        app.get('/voice-audio/:itemId', (req, res) => {
            if (!validateVoiceSession || !validateVoiceSession(req)) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            if (!clipSessionId) {
                return res.status(404).json({ error: 'Voice audio clip not found.' });
            }
            const paths = voiceAudioPathsForItem(req.params.itemId);
            if (!paths || !fs.existsSync(paths.audio_file)) {
                return res.status(404).json({ error: 'Voice audio clip not found.' });
            }
            res.setHeader('Content-Type', 'audio/ogg');
            res.sendFile(paths.audio_file);
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

            socket.on('voice_audio_clip', (data) => {
                const operatorId =
                    typeof getOperatorSocketId === 'function'
                        ? getOperatorSocketId()
                        : undefined;
                if (!operatorId || socket.id !== operatorId) {
                    console.warn(
                        '[VoiceInteractionLogger] Rejected voice_audio_clip: not operator socket',
                    );
                    return;
                }
                const bytes = pcmByteLength(data && data.pcm);
                if (bytes > MAX_VOICE_CLIP_PCM_BYTES) {
                    console.warn(
                        `[VoiceInteractionLogger] Rejected voice_audio_clip: PCM ${bytes} bytes exceeds ${MAX_VOICE_CLIP_PCM_BYTES}`,
                    );
                    return;
                }
                encodeAndWriteVoiceClip(data || {}).catch((err) => {
                    console.error(
                        '[VoiceInteractionLogger] Error encoding voice_audio_clip:',
                        err,
                    );
                });
            });
        });
    }
}

/**
 * Logs a single voice interaction record to disk, stdout, and live SSE stream.
 */
function logVoiceInteraction(data) {
    if (!isLogSvcEnabled() || !data) return;

    const now = new Date();
    const isoTimestamp = now.toISOString();
    const itemId = data.item_id;
    const audioStartMs = data.audio_start_ms;
    const audioEndMs = data.audio_end_ms;

    // Tool/interaction rows stay on the realtime stream. Transcribe finals
    // come only from logVoiceAssistantLog (STT onLog) to avoid duplicate 🎧 lines.
    let realtimeRecord = {
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
    realtimeRecord = attachAudioFields(
        realtimeRecord,
        itemId,
        audioStartMs,
        audioEndMs,
    );

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
    const audioHint = realtimeRecord.audio_file
        ? chalk.grey(` 🎧 ${realtimeRecord.audio_file}`)
        : '';

    console.log(
        `${chalk.grey(`[RealtimeModel ${timeShort}]`)} ` +
        `🗣️  ${chalk.cyan(transcriptText)} ➔ ` +
        `🛠️  ${chalk.yellow(toolText)} ➔ ` +
        `${statusIcon} ${chalk.grey(`(${realtimeRecord.execution.detail})`)}${audioHint}`
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
    if (!isLogSvcEnabled() || !data) return;

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
    if (!isLogSvcEnabled() || !data) return;

    const now = new Date();
    const isoTimestamp = now.toISOString();
    const message = typeof data === 'string' ? data : (data.log || data.message || '');
    const itemId = typeof data === 'object' ? data.item_id : undefined;
    const audioStartMs = typeof data === 'object' ? data.audio_start_ms : undefined;
    const audioEndMs = typeof data === 'object' ? data.audio_end_ms : undefined;
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

        let record = {
            type,
            model: 'gpt-4o-transcribe',
            timestamp: isoTimestamp,
            session_id: sessionId || `session_${getTimestampString(now)}`,
            fleet_id: process.env.HELLO_FLEET_ID || 'unknown',
            message: text,
        };
        // Link uplink Opus only on completed finals (not partials / wake-sleep).
        if (type === 'final') {
            record = attachAudioFields(record, itemId, audioStartMs, audioEndMs);
        }

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
            if (record.audio_file) {
                formatted += chalk.grey(` 🎧 ${record.audio_file}`);
            }
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
    setClipSession,
    logVoiceInteraction,
    logVoiceAssistantLog,
    logMicEvent,
};
