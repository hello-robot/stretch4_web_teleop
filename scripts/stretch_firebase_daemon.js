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
    apiKey: process.env.apiKey,
    authDomain: process.env.authDomain,
    databaseURL: process.env.databaseURL,
    projectId: process.env.projectId,
    storageBucket: process.env.storageBucket,
    messagingSenderId: process.env.messagingSenderId,
    appId: process.env.appId,
    measurementId: process.env.measurementId,
};

const roboUsername = process.env.roboUsername;
const roboPassword = process.env.roboPassword;

if (!roboUsername || !roboPassword) {
    console.error('ERROR: roboUsername or roboPassword missing in .env');
    process.exit(1);
}

const app = initializeApp(config);
const auth = getAuth(app);
const db = getDatabase(app);

let currentStatus = 'offline';
let isProcessingCommand = false;
const repoRoot = path.join(__dirname, '..');

const fs = require('fs');

function setStatus(status) {
    if (!auth.currentUser) return;
    currentStatus = status;
    const uid = auth.currentUser.uid;
    console.log(`[DAEMON] Setting status for ${uid} (${fleetId}) to: ${status}`);
    update(ref(db, `robots/${fleetId}`), {
        status: status,
        name: fleetId,
        uid: uid,
        last_updated: Date.now()
    }).catch((err) => console.error('[DAEMON] Error updating status:', err.message));
}

function checkInterfaceRunning() {
    return new Promise((resolve) => {
        exec("pgrep -f '[w]eb_interface.launch.py'", (error, stdout) => {
            resolve(!error && stdout.trim().length > 0);
        });
    });
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
            let alias = requestedBy;
            try {
                const uidSnap = await get(ref(db, `uids/${requestedBy}`));
                if (uidSnap.exists()) alias = uidSnap.val();
            } catch (e) {}

            const isOwner = mapData.owner_uid === requestedBy || mapData.owner_uid === alias;
            const isAllowed = mapData.allowed_users &&
                (mapData.allowed_users[requestedBy] || mapData.allowed_users[alias] || mapData.allowed_users[fleetId]);

            let isAssigned = false;
            try {
                const assignSnap1 = await get(ref(db, `assignments/${alias}/maps/${mapId}`));
                const assignSnap2 = await get(ref(db, `assignments/${requestedBy}/maps/${mapId}`));
                isAssigned = assignSnap1.exists() || assignSnap2.exists();
            } catch (e) {}

            if (!isOwner && !isAllowed && !isAssigned) {
                console.warn(`[DAEMON] Security Alert: User '${requestedBy}' (${alias}) is not authorized for map '${mapId}'.`);
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
        return foundLocalYaml;
    }
}

async function handleLaunchCommand(requestedBy, mapId) {
    if (isProcessingCommand) {
        console.log('[DAEMON] Already processing a command, ignoring launch request.');
        return;
    }

    isProcessingCommand = true;
    console.log(`[DAEMON] Received LAUNCH command from user: ${requestedBy}, map: ${mapId || 'none'}`);
    setStatus('launching');

    let mapArg = '';
    if (mapId) {
        const localMapYaml = await ensureMapLocal(mapId, requestedBy);
        if (localMapYaml) {
            mapArg = `-m "${localMapYaml}"`;
        }
    }

    const launchScript = path.join(repoRoot, 'launch_interface_firebase.sh');
    const cmdStr = mapArg ? `bash -l -c "${launchScript} ${mapArg}"` : `bash -l -c "${launchScript}"`;

    exec(cmdStr, { cwd: repoRoot }, (error, stdout, stderr) => {
        isProcessingCommand = false;
        if (error) {
            console.error('[DAEMON] Failed to launch interface:', error.message);
            console.error(stderr);
            setStatus('standby');
        } else {
            console.log('[DAEMON] launch_interface_firebase.sh succeeded.');
            // Status will be transitioned to 'online' by robot browser joining room
        }
    });
}

function handleStopCommand(requestedBy) {
    if (isProcessingCommand) {
        console.log('[DAEMON] Already processing a command, ignoring stop request.');
        return;
    }

    isProcessingCommand = true;
    console.log(`[DAEMON] Received STOP command from user: ${requestedBy}`);

    const stopScript = path.join(repoRoot, 'stop_interface.sh');

    execFile(stopScript, [], { cwd: repoRoot }, (error, stdout, stderr) => {
        isProcessingCommand = false;
        if (error) {
            console.error('[DAEMON] Error running stop_interface.sh:', error.message);
        } else {
            console.log('[DAEMON] stop_interface.sh succeeded.');
        }
        setStatus('standby');
    });
}

async function initDaemon() {
    try {
        console.log(`[DAEMON] Logging in as robot user (${roboUsername})...`);
        const userCredential = await signInWithEmailAndPassword(auth, roboUsername, roboPassword);
        const uid = userCredential.user.uid;
        console.log(`[DAEMON] Logged in successfully. Robot UID: ${uid}`);

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

        // Listen for remote control commands
        onValue(controlRef, (snapshot) => {
            const controlData = snapshot.val();
            if (!controlData || !controlData.action) return;

            const { action, requested_by } = controlData;

            if (action === 'launch') {
                handleLaunchCommand(requested_by, controlData.map_id || controlData.map_name);
                // Clear command once consumed
                set(controlRef, null);
            } else if (action === 'stop') {
                handleStopCommand(requested_by);
                set(controlRef, null);
            }
        });

    } catch (err) {
        console.error('[DAEMON] Initialization error:', err.message);
        setTimeout(initDaemon, 10000); // Retry after 10 seconds
    }
}

// Start daemon
initDaemon();
