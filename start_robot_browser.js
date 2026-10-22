#!/usr/bin/env node
const { firefox } = require("playwright");
const chalk = require("chalk");
const path = require("path");
const {
    formatBrowserConsoleMessage,
    isClosedTargetError,
    navigateWithRetry,
} = require("./start_robot_browser_helpers");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const logId = "start_robot_browser.js";

// You may want to change this to test that the
// robot is using certificates that are valid for its real hostname
let robotHostname = "localhost"; // or NGROK_URL
if (process.argv.length > 2) {
    robotHostname = process.argv[2];
}

const fleetId = process.env.HELLO_FLEET_ID || "unknown";
const roboUser = process.env.ROBOT_USERNAME || "";
const roboPass = process.env.ROBOT_PASSWORD || "";
const isFirebaseMode = process.env.WEB_TELEOP_DIST === "dist-firebase";
const urlParams = `?fleet_id=${encodeURIComponent(fleetId)}`;

if (
    isFirebaseMode &&
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(robotHostname)
) {
    throw new Error("Firebase robot credentials may only be injected on loopback");
}
if (isFirebaseMode && (!roboUser || !roboPass)) {
    throw new Error("Missing robot Firebase credentials");
}

const listenConsole = (page) => {
    const colors = {
        LOG: chalk.grey, // (text: any) => text,
        ERR: chalk.red,
        WAR: chalk.yellow,
        INF: chalk.cyan,
    };

    // listen to browser console
    page.on("console", (msg) => {
        const { type, text } = formatBrowserConsoleMessage(msg);
        const color = colors[type] || chalk.blue;
        console.log(color(`CONSOLE.${type}: ${text}`));
    });
};

async function main() {
    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    const browser = await firefox.launch({
        headless: true, // default is true
        handleSIGINT: false,
        defaultViewport: null,
        firefoxUserPrefs: {
            "permissions.default.microphone": 1, // Give permission to access the robot's microphone
        },
    });

    const context = await browser.newContext({ ignoreHTTPSErrors: true }); // avoid ERR_CERT_COMMON_NAME_INVALID
    // The robot account is available only inside this trusted local Playwright
    // context. It never enters webpack definitions, URLs, or HTTP logs.
    if (isFirebaseMode) {
        await context.addInitScript(
            ({ username, password }) => {
                Object.defineProperty(window, "__STRETCH_ROBOT_FIREBASE_AUTH__", {
                    value: Object.freeze({ username, password }),
                    configurable: true,
                    enumerable: false,
                    writable: false,
                });
            },
            { username: roboUser, password: roboPass },
        );
    }

    const page = await context.newPage();
    listenConsole(page);

    await navigateWithRetry({
        navigate: () =>
            page.goto(`https://${robotHostname}/robot${urlParams}`),
        sleep,
        log: console.log,
    });
    console.log(logId + ": finished loading");

    console.log(logId + ": start script complete");
    let isClosing = false;
    async function closeRobotBrowser() {
        if (isClosing) return;
        isClosing = true;

        // Navigating triggers window.onbeforeunload; page.close() does not.
        if (!page.isClosed()) {
            try {
                await Promise.race([
                    page
                        .goto(`https://${robotHostname}/whatever`)
                        .catch((error) => {
                            if (!isClosedTargetError(error)) throw error;
                        }),
                    sleep(500),
                ]);
            } catch (error) {
                console.warn(
                    `${logId}: shutdown navigation failed:`,
                    error,
                );
            }
        }
        await browser.close().catch((error) => {
            if (!isClosedTargetError(error)) {
                console.warn(`${logId}: browser close failed:`, error);
            }
        });
    }
    process.once("SIGTERM", () => {
        closeRobotBrowser().finally(() => process.exit(0));
    });
    process.once("SIGINT", () => {
        closeRobotBrowser().finally(() => process.exit(0));
    });
}

main().catch((error) => {
    console.error(`${logId}: fatal error:`, error);
    process.exit(1);
});
