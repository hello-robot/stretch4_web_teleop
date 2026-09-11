#!/usr/bin/env node

/**
 * Live watcher utility for ROS 2 Launch and Node Logs.
 * Tails ~/.ros/log/latest/launch.log with real-time formatting,
 * epoch timestamp conversion, node colorization, and level badges.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const chalk = require('chalk');

// CLI options
const args = process.argv.slice(2);
const errorsOnly = args.includes('--errors') || args.includes('-e');
const warnOrErrorOnly = args.includes('--warn') || args.includes('-w');
const filterNodeArg = args.find((a) => a.startsWith('--node='));
const filterNode = filterNodeArg ? filterNodeArg.split('=')[1].toLowerCase() : null;

function resolveLogPath() {
    const defaultLog = path.join(os.homedir(), '.ros', 'log', 'latest', 'launch.log');
    if (fs.existsSync(defaultLog)) {
        try {
            return fs.realpathSync(defaultLog);
        } catch (_) {
            return defaultLog;
        }
    }

    // Fallback: search for the newest launch.log directory in ~/.ros/log
    const rosLogDir = path.join(os.homedir(), '.ros', 'log');
    if (fs.existsSync(rosLogDir)) {
        try {
            const dirs = fs.readdirSync(rosLogDir)
                .filter((d) => d !== 'latest')
                .map((d) => {
                    const full = path.join(rosLogDir, d, 'launch.log');
                    return {
                        path: full,
                        mtime: fs.existsSync(full) ? fs.statSync(full).mtimeMs : 0,
                    };
                })
                .filter((item) => item.mtime > 0)
                .sort((a, b) => b.mtime - a.mtime);

            if (dirs.length > 0) {
                return dirs[0].path;
            }
        } catch (_) {}
    }

    return defaultLog;
}

function formatEpochTime(epochStr) {
    try {
        const sec = parseFloat(epochStr);
        if (isNaN(sec)) return '--:--:--';
        const d = new Date(sec * 1000);
        return d.toTimeString().split(' ')[0];
    } catch (_) {
        return '--:--:--';
    }
}

function getNodeColor(nodeName) {
    const n = (nodeName || '').toLowerCase();
    if (n.includes('camera') || n.includes('luxonis') || n.includes('depthai') || n.includes('video')) {
        return chalk.cyan;
    }
    if (n.includes('stretch') || n.includes('driver') || n.includes('robot_state') || n.includes('joint') || n.includes('base')) {
        return chalk.magenta;
    }
    if (n.includes('aruco') || n.includes('tag') || n.includes('vision') || n.includes('perception')) {
        return chalk.green;
    }
    if (n.includes('rosbridge') || n.includes('rosapi') || n.includes('tf2') || n.includes('action')) {
        return chalk.blue;
    }
    if (n.includes('navigation') || n.includes('nav') || n.includes('map') || n.includes('costmap')) {
        return chalk.hex('#FFA500'); // Orange
    }
    if (n.includes('launch')) {
        return chalk.grey;
    }
    return chalk.yellowBright;
}

function formatAndPrintLine(line) {
    if (!line || !line.trim()) return;
    const trimmed = line.trim();

    let timestamp = '';
    let level = 'INFO';
    let node = '';
    let message = '';
    let isError = false;
    let isWarn = false;

    // 1. Full pattern: <epoch> [<proc>] [<LEVEL>] [<inner_epoch>] [<node>]: <msg>
    // e.g.: 1786983622.5376704 [component_container-4] [INFO] [1786983622.537479490] [luxonis_container]: Instantiate class: ...
    let match = trimmed.match(/^(\d+\.\d+)\s+\[([^\]]+)\]\s+\[(INFO|WARN|ERROR|DEBUG|FATAL)\]\s+\[\d+\.\d+\]\s+\[([^\]]+)\]:\s*(.*)$/);
    if (match) {
        timestamp = formatEpochTime(match[1]);
        level = match[3];
        node = match[4];
        message = match[5];
    } else {
        // 2. Standard pattern: <epoch> [<LEVEL>] [<node_or_proc>]: <msg>
        // e.g.: 1786983622.5405028 [INFO] [launch_ros.actions.load_composable_nodes]: Loaded node...
        // e.g.: 1786983819.5456469 [ERROR] [aruco_detection.py-14]: process has died...
        match = trimmed.match(/^(\d+\.\d+)\s+\[(INFO|WARN|ERROR|DEBUG|FATAL)\]\s+\[([^\]]+)\]:\s*(.*)$/);
        if (match) {
            timestamp = formatEpochTime(match[1]);
            level = match[2];
            node = match[3];
            message = match[4];
        } else {
            // 3. Hardware device driver log pattern:
            // e.g.: 1786983628.2319679 [component_container-4] [18443010E13DE8F400] [3.3.1] [2.882] [Camera(0)] [warning] Calibration data not found
            match = trimmed.match(/^(\d+\.\d+)\s+\[([^\]]+)\]\s+\[[^\]]+\]\s+\[[^\]]+\]\s+\[[^\]]+\]\s+\[([^\]]+)\]\s+\[(warning|error|info)\]\s*(.*)$/i);
            if (match) {
                timestamp = formatEpochTime(match[1]);
                node = `${match[2]} ${match[3]}`;
                const rawLvl = match[4].toUpperCase();
                level = rawLvl.startsWith('WARN') ? 'WARN' : (rawLvl.startsWith('ERR') ? 'ERROR' : 'INFO');
                message = match[5];
            } else {
                // 4. Process event / generic pattern: <epoch> [<proc>] <msg>
                // e.g.: 1786983622.8758752 [Empty "{}"-13] waiting for service to become available...
                match = trimmed.match(/^(\d+\.\d+)\s+\[([^\]]+)\]\s+(.*)$/);
                if (match) {
                    timestamp = formatEpochTime(match[1]);
                    node = match[2];
                    message = match[3];
                    if (/error|failed|fatal|died|exception/i.test(message)) {
                        level = 'ERROR';
                    } else if (/warn|warning/i.test(message)) {
                        level = 'WARN';
                    } else {
                        level = 'INFO';
                    }
                }
            }
        }
    }

    if (!match) {
        // Fallback for continuation lines or unstructured text (e.g. stack traces)
        if (errorsOnly) return;
        if (/traceback|exception|error/i.test(trimmed)) {
            console.log(chalk.red(`  ↳ ${trimmed}`));
        } else if (/warning/i.test(trimmed)) {
            console.log(chalk.yellow(`  ↳ ${trimmed}`));
        } else {
            console.log(chalk.grey(`  ↳ ${trimmed}`));
        }
        return;
    }

    if (level === 'ERROR' || level === 'FATAL') isError = true;
    if (level === 'WARN') isWarn = true;

    // Filters
    if (errorsOnly && !isError) return;
    if (warnOrErrorOnly && !isError && !isWarn) return;
    if (filterNode && !node.toLowerCase().includes(filterNode)) return;

    // Format badge
    let badge = '';
    let msgFormatted = message;

    if (isError) {
        badge = chalk.bgRed.white.bold(' ERR ');
        msgFormatted = chalk.red.bold(message);
    } else if (isWarn) {
        badge = chalk.yellow.bold('WARN ');
        msgFormatted = chalk.yellow(message);
    } else if (level === 'DEBUG') {
        badge = chalk.grey('DEBUG');
        msgFormatted = chalk.grey(message);
    } else {
        badge = chalk.cyan('INFO ');
        // Highlight specific useful events in INFO
        if (/process started/i.test(message)) {
            msgFormatted = chalk.green(message);
        } else if (/driver ready|connected/i.test(message)) {
            msgFormatted = chalk.greenBright.bold(message);
        } else {
            msgFormatted = chalk.white(message);
        }
    }

    const nodeColor = getNodeColor(node);
    const nodeTag = nodeColor.bold(`[${node}]`);
    const timeTag = chalk.grey(`[${timestamp}]`);

    console.log(`${timeTag} ${badge} ${nodeTag} ${msgFormatted}`);
}

function main() {
    let logPath = resolveLogPath();

    console.log(chalk.bold.hex('#FF6B6B')('\n======================================================'));
    console.log(chalk.bold.hex('#FF6B6B')('             ROS 2 LAUNCH LIVE MONITOR                '));
    console.log(chalk.bold.hex('#FF6B6B')('======================================================'));
    console.log(chalk.grey(`Target Log File: ${logPath}`));
    if (errorsOnly) console.log(chalk.red.bold('Mode: Errors Only (--errors)'));
    if (warnOrErrorOnly) console.log(chalk.yellow.bold('Mode: Warnings & Errors (--warn)'));
    if (filterNode) console.log(chalk.cyan(`Filter Node: ${filterNode}`));
    console.log('');

    if (!fs.existsSync(logPath)) {
        console.log(chalk.yellow(`Waiting for ROS launch log to be created at: ${logPath} ...`));
    }

    let fileSize = 0;
    if (fs.existsSync(logPath)) {
        const stats = fs.statSync(logPath);
        fileSize = stats.size;

        // Print initial recent history (last 50KB or ~100 lines)
        const readStart = Math.max(0, stats.size - 50000);
        const buffer = Buffer.alloc(stats.size - readStart);
        const fd = fs.openSync(logPath, 'r');
        fs.readSync(fd, buffer, 0, buffer.length, readStart);
        fs.closeSync(fd);

        const initialLines = buffer.toString('utf8').split('\n');
        // If we didn't read from start of file, discard partial first line
        const linesToProcess = readStart > 0 ? initialLines.slice(1) : initialLines;
        linesToProcess.slice(-60).forEach(formatAndPrintLine);
    }

    // Watch loop with dynamic symlink checking
    let watchTimer = setInterval(() => {
        const currentResolved = resolveLogPath();
        if (currentResolved !== logPath && fs.existsSync(currentResolved)) {
            logPath = currentResolved;
            fileSize = 0;
            console.log(chalk.hex('#FF6B6B')(`\n✨ Switched to new ROS launch session: ${logPath}\n`));
        }

        if (!fs.existsSync(logPath)) return;

        try {
            const stats = fs.statSync(logPath);
            if (stats.size > fileSize) {
                const stream = fs.createReadStream(logPath, {
                    start: fileSize,
                    end: stats.size,
                    encoding: 'utf8',
                });
                fileSize = stats.size;
                let remainder = '';
                stream.on('data', (chunk) => {
                    const lines = (remainder + chunk).split('\n');
                    remainder = lines.pop(); // keep partial line
                    lines.forEach(formatAndPrintLine);
                });
            } else if (stats.size < fileSize) {
                // Log file rotated or truncated
                fileSize = stats.size;
            }
        } catch (_) {}
    }, 400);

    process.on('SIGINT', () => {
        clearInterval(watchTimer);
        console.log(chalk.grey('\nExiting ROS launch monitor.\n'));
        process.exit(0);
    });
}

main();
