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

function setStatus(status) {
    if (!auth.currentUser) return;
    currentStatus = status;
    const uid = auth.currentUser.uid;
    console.log(`[DAEMON] Setting status for ${uid} (${fleetId}) to: ${status}`);
    update(ref(db, `robots/${uid}`), {
        status: status,
        name: fleetId,
        last_updated: Date.now()
    }).catch((err) => console.error('[DAEMON] Error updating status:', err.message));
}

function checkInterfaceRunning() {
    return new Promise((resolve) => {
        exec('pgrep -f web_interface.launch.py', (error, stdout) => {
            resolve(!error && stdout.trim().length > 0);
        });
    });
}

function handleLaunchCommand(requestedBy) {
    if (isProcessingCommand) {
        console.log('[DAEMON] Already processing a command, ignoring launch request.');
        return;
    }

    isProcessingCommand = true;
    console.log(`[DAEMON] Received LAUNCH command from user: ${requestedBy}`);
    setStatus('launching');

    const launchScript = path.join(repoRoot, 'launch_interface.sh');
    
    // Execute launch_interface.sh -f
    execFile(launchScript, ['-f'], { cwd: repoRoot }, (error, stdout, stderr) => {
        isProcessingCommand = false;
        if (error) {
            console.error('[DAEMON] Failed to launch interface:', error.message);
            console.error(stderr);
            setStatus('standby');
        } else {
            console.log('[DAEMON] launch_interface.sh succeeded.');
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
        const statusRef = ref(db, `robots/${uid}/status`);
        const controlRef = ref(db, `robots/${uid}/control`);

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
                handleLaunchCommand(requested_by);
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
