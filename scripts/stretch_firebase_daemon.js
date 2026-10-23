#!/usr/bin/env node

/**
 * stretch_firebase_daemon.js
 *
 * Onboard daemon for Stretch Web Teleop.
 * Listens for remote launch/stop commands via Firebase Realtime Database
 * and manages robot presence ('offline', 'standby', 'launching', 'online', 'occupied').
 */

const path = require('path');
const { execFile, exec } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { envVarName, loadFeatures } = require('../feature-flags');
const {
    spawnProcessGroup,
    terminateProcessGroup,
} = require('./launchProcessGroup');

const { initializeApp } = require('firebase/app');
const { getAuth, signInWithEmailAndPassword } = require('firebase/auth');
const {
    getDatabase,
    ref,
    set,
    update,
    onValue,
    onDisconnect,
    get
} = require('firebase/database');

// Validate environment variables
const fleetId = process.env.HELLO_FLEET_ID;
if (!fleetId) {
    console.error('ERROR: HELLO_FLEET_ID is not defined in .env');
    process.exit(1);
}

const config = {
    apiKey: process.env.PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.PUBLIC_FIREBASE_AUTH_DOMAIN,
    databaseURL: process.env.PUBLIC_FIREBASE_DATABASE_URL,
    projectId: process.env.PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.PUBLIC_FIREBASE_APP_ID,
    measurementId: process.env.PUBLIC_FIREBASE_MEASUREMENT_ID,
};

const roboUsername = process.env.ROBOT_USERNAME;
const roboPassword = process.env.ROBOT_PASSWORD;

if (!roboUsername || !roboPassword) {
    console.error('ERROR: roboUsername or roboPassword missing in .env');
    process.exit(1);
}

const app = initializeApp(config);
const auth = getAuth(app);
const db = getDatabase(app);

let currentStatus = 'offline';
let currentBranch = null;
let isProcessingCommand = false;
let launchingSince = 0;
let reconcileTimer = null;
let launchChild = null;
let abortRequested = false;
let stopInFlight = false;
let launchEpoch = 0;
const repoRoot = path.join(__dirname, '..');

/** Tail kept in RTDB. Rules reject anything longer. */
const LAUNCH_LOG_MAX_CHARS = 32 * 1024;
const LAUNCH_LOG_FLUSH_MS = 1000;
let launchLog = '';
let launchLogPartial = '';
let launchLogTimer = null;
let lastPublishedLaunchLog = null;

function resetLaunchLogBuffer() {
    launchLog = '';
    launchLogPartial = '';
    if (launchLogTimer) {
        clearTimeout(launchLogTimer);
        launchLogTimer = null;
    }
}

function publishLaunchLog(text) {
    if (!auth.currentUser) return Promise.resolve();
    if (text === lastPublishedLaunchLog) return Promise.resolve();
    lastPublishedLaunchLog = text;
    return set(ref(db, `launch_logs/${fleetId}`), text).catch((err) => {
        lastPublishedLaunchLog = null;
        console.error('[DAEMON] Error updating launch log:', err.message);
    });
}

function clearLaunchLog() {
    resetLaunchLogBuffer();
    return publishLaunchLog('');
}

function flushLaunchLogSoon() {
    if (launchLogTimer) return;
    if (currentStatus !== 'launching' && !isProcessingCommand) return;
    launchLogTimer = setTimeout(() => {
        launchLogTimer = null;
        const visible = launchLogPartial
            ? (launchLog + launchLogPartial).slice(-LAUNCH_LOG_MAX_CHARS)
            : launchLog;
        publishLaunchLog(visible);
    }, LAUNCH_LOG_FLUSH_MS);
}

/** Line-buffer child output and publish the tail once a second while launching. */
function noteLaunchOutput(chunk) {
    launchLogPartial += chunk.toString();
    if (launchLogPartial.length > LAUNCH_LOG_MAX_CHARS) {
        launchLogPartial = launchLogPartial.slice(-LAUNCH_LOG_MAX_CHARS);
    }
    const lines = launchLogPartial.split('\n');
    launchLogPartial = lines.pop() ?? '';
    if (lines.length) {
        launchLog = (launchLog + lines.join('\n') + '\n').slice(-LAUNCH_LOG_MAX_CHARS);
    }
    flushLaunchLogSoon();
}

function flushLaunchLogNow() {
    if (launchLogTimer) {
        clearTimeout(launchLogTimer);
        launchLogTimer = null;
    }
    if (launchLogPartial) {
        launchLog = (launchLog + launchLogPartial).slice(-LAUNCH_LOG_MAX_CHARS);
        launchLogPartial = '';
    }
    return publishLaunchLog(launchLog);
}

const fs = require('fs');

/**
 * Line-buffers one source and stamps each line with where it came from.
 * Sources are merged into a single stream, so a half-written line must never
 * be published: whole lines only, or two logs splice into each other.
 */
function taggedSink(tag) {
    const prefix = `[${tag}] `;
    let partial = '';
    return {
        write(chunk) {
            partial += chunk.toString();
            if (partial.length > LAUNCH_LOG_MAX_CHARS) {
                partial = partial.slice(-LAUNCH_LOG_MAX_CHARS);
            }
            const lines = partial.split('\n');
            partial = lines.pop() ?? '';
            if (lines.length) {
                noteLaunchOutput(lines.map((line) => prefix + line).join('\n') + '\n');
            }
        },
        flush() {
            if (!partial) return;
            noteLaunchOutput(prefix + partial + '\n');
            partial = '';
        },
    };
}

/** Friendlier names than the filenames the launch writes side by side. */
const LOG_TAGS = {
    'web_interface_launch.txt': 'ros',
    'rmw_zenohd.txt': 'zenoh',
    'start_web_server_and_robot_browser.txt': 'web',
};

const logTagFor = (name) => LOG_TAGS[name] || name.replace(/\.[^.]+$/, '');

const LOG_TAIL_POLL_MS = 1000;
let logTailTimer = null;
let logTailDir = null;
const logTailSinks = new Map();
const logTailOffsets = new Map();

function pumpLogFile(name) {
    const file = path.join(logTailDir, name);
    let stat;
    try {
        stat = fs.statSync(file);
    } catch (err) {
        return; // written and removed between readdir and stat
    }
    if (!stat.isFile()) return;
    const seen = logTailOffsets.get(name) ?? 0;
    // Truncated or replaced under us: read it again from the top.
    const from = stat.size < seen ? 0 : seen;
    if (stat.size === from) return;
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(stat.size - from);
        const read = fs.readSync(fd, buf, 0, buf.length, from);
        logTailOffsets.set(name, from + read);
        if (!logTailSinks.has(name)) logTailSinks.set(name, taggedSink(logTagFor(name)));
        logTailSinks.get(name).write(buf.subarray(0, read));
    } catch (err) {
        console.warn(`[DAEMON] Could not read ${name}:`, err.message);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

function pumpLogDir() {
    if (!logTailDir) return;
    let names;
    try {
        names = fs.readdirSync(logTailDir);
    } catch (err) {
        return; // the launch has not created it yet
    }
    names.sort().forEach(pumpLogFile);
}

/**
 * The ROS launch and zenoh run inside detached screen sessions, so their
 * output never reaches our stdout pipe; it only lands in files next to the
 * launch log. Poll that directory and merge every file into the single
 * stream the dashboard reads, so one log shows the whole stack coming up.
 */
function startLaunchLogTail(dir) {
    stopLaunchLogTail();
    logTailDir = dir;
    logTailTimer = setInterval(pumpLogDir, LOG_TAIL_POLL_MS);
}

/** Drains whatever is left before letting go, so a crash on the way down is kept. */
function stopLaunchLogTail() {
    if (logTailTimer) {
        clearInterval(logTailTimer);
        logTailTimer = null;
    }
    if (!logTailDir) return;
    pumpLogDir();
    logTailSinks.forEach((sink) => sink.flush());
    logTailSinks.clear();
    logTailOffsets.clear();
    logTailDir = null;
}

/** Matches the layout launch_interface.sh uses, to the second. */
function launchLogDir() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return path.join(
        process.env.HOME,
        'stretch_user',
        'log',
        'web_teleop',
        `stretch4_web_teleop_${stamp}`,
    );
}

function readGitBranch() {
    return new Promise((resolve) => {
        exec('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot }, (error, stdout) => {
            if (error) return resolve(null);
            const name = stdout.trim();
            return resolve(!name || name === 'HEAD' ? 'unknown' : name);
        });
    });
}

async function refreshBranch() {
    currentBranch = await readGitBranch();
    return currentBranch;
}

/** RTDB update deletes a key whose value is null, so omit branch until git answers. */
function branchField() {
    return currentBranch ? { branch: currentBranch } : {};
}

function publishBranch() {
    if (!auth.currentUser || !currentBranch) return;
    update(ref(db, `robots/${fleetId}`), { branch: currentBranch })
        .catch((err) => console.error('[DAEMON] Error updating branch:', err.message));
}

function setStatus(status) {
    if (status !== 'launching') stopLaunchLogTail();
    if (!auth.currentUser) return;
    currentStatus = status;
    if (status === 'launching') launchingSince = Date.now();
    const uid = auth.currentUser.uid;
    console.log(`[DAEMON] Setting status for ${uid} (${fleetId}) to: ${status}`);
    update(ref(db, `robots/${fleetId}`), {
        status: status,
        name: fleetId,
        uid: uid,
        last_updated: Date.now(),
        ...branchField(),
    }).catch((err) => console.error('[DAEMON] Error updating status:', err.message));
}

/**
 * Per-robot feature-flag overrides chosen on the dashboard, stored at
 * robots/<fleetId>/config/<flag>. Only flags declared in features.json are
 * honoured; anything else is ignored so a stray key cannot inject env vars.
 *
 * @returns {Promise<Record<string, string>>} FEATURE_* env entries ("1"/"0")
 */
async function readFeatureEnv() {
    let overrides = {};
    try {
        const snap = await get(ref(db, `robots/${fleetId}/config`));
        overrides = snap.exists() ? snap.val() || {} : {};
    } catch (err) {
        console.warn('[DAEMON] Could not read robot config, using features.json defaults:', err.message);
    }
    const defaults = loadFeatures();
    return Object.fromEntries(
        Object.entries(defaults).map(([flag, enabled]) => [
            envVarName(flag),
            (flag in overrides ? Boolean(overrides[flag]) : enabled) ? '1' : '0',
        ])
    );
}

async function readSavedMapId() {
    try {
        const snap = await get(ref(db, `robots/${fleetId}/map_id`));
        return snap.exists() ? snap.val() : null;
    } catch (err) {
        console.warn('[DAEMON] Could not read saved map_id:', err.message);
        return null;
    }
}

function pgrepRunning(pattern) {
    return new Promise((resolve) => {
        execFile('pgrep', ['-f', pattern], (error, stdout) => {
            resolve(!error && stdout.trim().length > 0);
        });
    });
}

function checkInterfaceRunning() {
    return pgrepRunning('[w]eb_interface.launch.py');
}

function screenSessionExists(name) {
    return new Promise((resolve) => {
        execFile('screen', ['-ls'], (error, stdout) => {
            resolve(!error && stdout.includes(name));
        });
    });
}

/** True while the daemon, the launch script, ROS, or the web interface is up. */
async function launchInProgress() {
    if (isProcessingCommand || launchChild) return true;
    const [script, iface, screenUp] = await Promise.all([
        pgrepRunning('[l]aunch_interface_firebase.sh'),
        checkInterfaceRunning(),
        screenSessionExists('web_teleop_ros'),
    ]);
    return script || iface || screenUp;
}

/** Don't leave the dashboard on Starting after the stack exits or never comes up. */
const LAUNCH_GRACE_MS = 20000;
const LAUNCH_ONLINE_TIMEOUT_MS = 90000;

async function reconcileInterfaceStatus() {
    if (!['launching', 'online', 'occupied'].includes(currentStatus)) return;
    const inProgress = await launchInProgress();
    if (!inProgress) {
        if (currentStatus === 'launching' && Date.now() - launchingSince < LAUNCH_GRACE_MS) return;
        console.warn('[DAEMON] Teleop interface is not running. Setting standby.');
        setStatus('standby');
        return;
    }
    const iface = await checkInterfaceRunning();
    if (currentStatus === 'launching' && iface && launchingSince && Date.now() - launchingSince > LAUNCH_ONLINE_TIMEOUT_MS) {
        console.warn('[DAEMON] Interface is up, but status is still launching. Setting online.');
        setStatus('online');
    }
}

async function ensureMapLocal(mapId, requestedBy) {
    if (!mapId) return null;
    const fleetPath = process.env.HELLO_FLEET_PATH || path.join(process.env.HOME, 'stretch_user');
    const mapsDir = path.join(fleetPath, 'maps');

    // Direct local yaml check
    const directYaml = path.join(mapsDir, `${mapId}.yaml`);
    const subDirYaml = path.join(mapsDir, mapId, `${mapId}.yaml`);
    let foundLocalYaml = null;
    if (fs.existsSync(directYaml)) foundLocalYaml = directYaml;
    else if (fs.existsSync(subDirYaml)) foundLocalYaml = subDirYaml;

    // Fetch from Firebase DB to verify / obtain map record
    console.log(`[DAEMON] Checking Firebase DB for map '${mapId}'...`);
    try {
        let mapSnap = await get(ref(db, `maps/${mapId}`));
        if (!mapSnap.exists()) {
            mapSnap = await get(ref(db, `robots/${fleetId}/maps/${mapId}`));
        }

        if (mapSnap.exists() && requestedBy) {
            const mapData = mapSnap.val();
            const alias = requestedBy;
            const isOwner = mapData.owner_uid === alias;
            const isAllowed = mapData.allowed_users &&
                (mapData.allowed_users[alias] || mapData.allowed_users[fleetId]);

            let isAssigned = false;
            try {
                const assignSnap1 = await get(ref(db, `assignments/${alias}/maps/${mapId}`));
                isAssigned = assignSnap1.exists();
            } catch (e) {}

            if (!isOwner && !isAllowed && !isAssigned) {
                console.warn(`[DAEMON] Security Alert: User '${alias}' is not authorized for map '${mapId}'.`);
                return null;
            }
        }

        if (foundLocalYaml) return foundLocalYaml;

        if (!mapSnap.exists()) {
            console.warn(`[DAEMON] Map '${mapId}' not found in Firebase DB under /maps/ or /robots/${fleetId}/maps/`);
            return null;
        }

        const mapData = mapSnap.val();
        const { yaml_content, pgm_filename, pgm_base64 } = mapData;
        if (!yaml_content || !pgm_base64) {
            console.warn(`[DAEMON] Map '${mapId}' payload missing yaml_content or pgm_base64.`);
            return null;
        }

        const targetDir = path.join(mapsDir, mapId);
        fs.mkdirSync(targetDir, { recursive: true });

        const targetYaml = path.join(targetDir, `${mapId}.yaml`);
        const targetPgm = path.join(targetDir, pgm_filename || `${mapId}.pgm`);

        fs.writeFileSync(targetYaml, yaml_content, 'utf8');
        fs.writeFileSync(targetPgm, Buffer.from(pgm_base64, 'base64'));

        console.log(`[DAEMON] Map '${mapId}' successfully downloaded to ${targetYaml}`);
        return targetYaml;
    } catch (err) {
        console.error(`[DAEMON] Failed to fetch map '${mapId}':`, err.message);
        if (foundLocalYaml) {
            console.warn(`[DAEMON] Using the copy already on disk: ${foundLocalYaml}`);
            return foundLocalYaml;
        }
        console.warn(`[DAEMON] Launch will continue without map '${mapId}'.`);
        return null;
    }
}

async function handleLaunchCommand(requestedBy, mapId) {
    if (isProcessingCommand) {
        console.log('[DAEMON] Already processing a command, ignoring launch request.');
        return;
    }

    isProcessingCommand = true;
    const epoch = ++launchEpoch;
    try {
        await refreshBranch();
        const effectiveMapId = mapId || (await readSavedMapId());
        console.log(`[DAEMON] Received LAUNCH command from user: ${requestedBy}, map: ${effectiveMapId || 'none'}`);
        stopLaunchLogTail();
        await clearOperatorSeat();
        await clearLaunchLog();
        noteLaunchOutput(`[DAEMON] Launch requested by ${requestedBy}, map: ${effectiveMapId || 'none'}\n`);
        setStatus('launching');

        const logDir = launchLogDir();
        try {
            fs.mkdirSync(logDir, { recursive: true });
            startLaunchLogTail(logDir);
        } catch (err) {
            console.warn('[DAEMON] Could not open the launch log directory:', err.message);
        }

        const launchArgs = [];
        if (effectiveMapId) {
            const localMapYaml = await ensureMapLocal(effectiveMapId, requestedBy);
            if (localMapYaml) {
                launchArgs.push('-m', localMapYaml);
            }
        }

        const featureEnv = await readFeatureEnv();
        console.log('[DAEMON] Launching with feature flags:', featureEnv);
        noteLaunchOutput(`[DAEMON] Launching with feature flags: ${JSON.stringify(featureEnv)}\n`);

        if (epoch !== launchEpoch || abortRequested || stopInFlight) {
            console.log('[DAEMON] Launch aborted before the interface script started.');
            return;
        }

        // The same script a person runs, with the same flag. A claim already
        // proves what the Firebase probe re-checks -- the database rules gate
        // robots/<fleetId> on exactly the assignment the probe asserts -- so the
        // probe is redundant here, and worth it: one launch path means a change
        // lands on both callers instead of drifting between two.
        const launchScript = path.join(repoRoot, 'launch_interface.sh');
        launchArgs.push('-f');
        noteLaunchOutput(`[DAEMON] Starting ${path.basename(launchScript)} -f\n`);
        const child = spawnProcessGroup(
            launchScript,
            launchArgs,
            {
                cwd: repoRoot,
                env: { ...process.env, ...featureEnv, WEB_TELEOP_LOG_DIR: logDir },
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        );
        launchChild = child;
        let stderr = '';
        const outSink = taggedSink('launch');
        const errSink = taggedSink('launch');
        child.stdout.on('data', (chunk) => outSink.write(chunk));
        child.stderr.on('data', (chunk) => {
            errSink.write(chunk);
            stderr = (stderr + chunk.toString()).slice(-10000);
        });

        let finished = false;
        const finish = (error) => {
            if (finished) return;
            finished = true;
            if (launchChild === child) launchChild = null;
            outSink.flush();
            errSink.flush();
            if (abortRequested || stopInFlight) return;
            isProcessingCommand = false;
            if (error) {
                console.error('[DAEMON] Failed to launch interface:', error.message);
                if (stderr) console.error(stderr);
                noteLaunchOutput(`[DAEMON] Failed to launch interface: ${error.message}\n`);
                flushLaunchLogNow();
                setStatus('standby');
                return;
            }
            console.log('[DAEMON] launch_interface.sh succeeded.');
            noteLaunchOutput('[DAEMON] launch_interface.sh succeeded.\n');
            flushLaunchLogNow();
            // Status will be transitioned to 'online' by robot browser joining room
        };
        child.once('error', finish);
        child.once('close', (code, signal) => {
            const error = code === 0
                ? null
                : new Error(`launch script exited with code ${code ?? 'null'} signal ${signal ?? 'none'}`);
            finish(error);
        });
    } catch (error) {
        if (!abortRequested && !stopInFlight) {
            console.error('[DAEMON] Failed to prepare interface launch:', error.message);
            noteLaunchOutput(`[DAEMON] Failed to prepare interface launch: ${error.message}\n`);
            flushLaunchLogNow();
            setStatus('standby');
        }
    } finally {
        if (!launchChild && !stopInFlight) {
            isProcessingCommand = false;
        }
    }
}

function clearOperatorSeat() {
    const uid = auth.currentUser && auth.currentUser.uid;
    if (!uid) return Promise.resolve();
    // transport firebase and no sessionId: rules allow the robot to clear a
    // firebase seat without taking a local lease.
    return set(ref(db, `rooms/${uid}/operator`), {
        active: false,
        transport: "firebase",
    }).catch((err) =>
        console.error('[DAEMON] Error clearing operator seat:', err.message),
    );
}

function runStopScript() {
    const stopScript = path.join(repoRoot, 'stop_interface.sh');
    return new Promise((resolve) => {
        execFile(stopScript, [], { cwd: repoRoot }, (error, stdout, stderr) => {
            if (error) {
                console.error('[DAEMON] Error running stop_interface.sh:', error.message);
                if (stderr) console.error(stderr);
            } else {
                console.log('[DAEMON] stop_interface.sh succeeded.');
            }
            resolve();
        });
    });
}

async function handleStopCommand(requestedBy) {
    console.log(`[DAEMON] Received STOP command from user: ${requestedBy}`);
    launchEpoch += 1;
    if (stopInFlight) return;
    stopInFlight = true;
    abortRequested = true;
    isProcessingCommand = true;

    try {
        const child = launchChild;
        if (child) {
            await terminateProcessGroup(child);
            if (launchChild === child) launchChild = null;
        }
        await clearOperatorSeat();
        await runStopScript();
    } finally {
        stopInFlight = false;
        abortRequested = false;
        isProcessingCommand = false;
        stopLaunchLogTail();
        await clearLaunchLog();
        setStatus('standby');
    }
}

async function initDaemon() {
    try {
        console.log(`[DAEMON] Logging in as robot user (${roboUsername})...`);
        const userCredential = await signInWithEmailAndPassword(auth, roboUsername, roboPassword);
        const uid = userCredential.user.uid;
        console.log(`[DAEMON] Logged in successfully. Robot UID: ${uid}`);
        console.log(`[DAEMON] Repo branch: ${(await refreshBranch()) || 'unknown'}`);
        publishBranch();

        // Set up presence monitoring via .info/connected
        const connectedRef = ref(db, '.info/connected');
        const statusRef = ref(db, `robots/${fleetId}/status`);
        const controlRef = ref(db, `robots/${fleetId}/control`);

        onValue(connectedRef, async (snapshot) => {
            if (snapshot.val() === true) {
                console.log('[DAEMON] Connected to Firebase.');

                // Ensure presence onDisconnect sets status to 'offline'
                onDisconnect(statusRef).set('offline');

                // Check if ROS interface is already running
                const isRunning = await checkInterfaceRunning();
                if (!isRunning) {
                    setStatus('standby');
                } else {
                    // Check existing status or default to online
                    get(statusRef).then((snap) => {
                        const val = snap.val();
                        if (val === 'launching' || val === 'online' || val === 'occupied') {
                            setStatus(val);
                        } else {
                            setStatus('online');
                        }
                    });
                }
            } else {
                console.log('[DAEMON] Disconnected from Firebase.');
            }
        });

        // Keep currentStatus synchronized with transitions written by the robot browser
        // (e.g. 'launching' -> 'online' <-> 'occupied') so launch log tailing stops as
        // soon as the robot is online and reconcileInterfaceStatus knows the live state.
        onValue(statusRef, (snapshot) => {
            const val = snapshot.val();
            if (!val || val === currentStatus) return;
            if (val === 'offline' && currentStatus === 'launching' && (isProcessingCommand || launchChild)) {
                // A previous robot browser shutting down during relaunch wrote 'offline';
                // restore 'launching' while the new launch is actively in progress.
                setStatus('launching');
                return;
            }
            const wasLaunching = currentStatus === 'launching';
            currentStatus = val;
            if (wasLaunching && val !== 'launching') {
                stopLaunchLogTail();
                flushLaunchLogNow();
            }
        });

        // Listen for remote control commands
        onValue(controlRef, (snapshot) => {
            const controlData = snapshot.val();
            if (!controlData || !controlData.action) return;

            const { action, requested_by } = controlData;

            if (action === 'launch') {
                handleLaunchCommand(requested_by, controlData.map_id || controlData.map_name).finally(() => {
                    // Clear command once consumed so that rules can read requested_by during map fetch
                    set(controlRef, null);
                });
            } else if (action === 'stop') {
                handleStopCommand(requested_by).catch((error) => {
                    console.error('[DAEMON] Stop command failed:', error.message);
                });
                set(controlRef, null);
            }
        });

        if (!reconcileTimer) {
            reconcileTimer = setInterval(reconcileInterfaceStatus, 15000);
        }

    } catch (err) {
        console.error('[DAEMON] Initialization error:', err.message);
        setTimeout(initDaemon, 10000); // Retry after 10 seconds
    }
}

// Start daemon
initDaemon();
