const { spawn } = require("child_process");

function spawnProcessGroup(command, args, options = {}) {
    return spawn(command, args, {
        ...options,
        detached: true,
    });
}

function signalProcessGroup(child, signal) {
    if (!child?.pid) return false;
    try {
        process.kill(-child.pid, signal);
        return true;
    } catch (error) {
        if (error.code === "ESRCH") return false;
        throw error;
    }
}

function terminateProcessGroup(child, graceMs = 3000) {
    if (!child?.pid || child.exitCode !== null) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        let settled = false;
        let forceTimer;
        let safetyTimer;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(forceTimer);
            clearTimeout(safetyTimer);
            child.off("close", finish);
            resolve();
        };

        child.once("close", finish);
        if (!signalProcessGroup(child, "SIGTERM")) {
            finish();
            return;
        }

        forceTimer = setTimeout(() => {
            signalProcessGroup(child, "SIGKILL");
        }, graceMs);
        safetyTimer = setTimeout(finish, graceMs + 2000);
    });
}

module.exports = {
    signalProcessGroup,
    spawnProcessGroup,
    terminateProcessGroup,
};
