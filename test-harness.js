#!/usr/bin/env node

/**
 * Test Harness for OpenAI Realtime Voice Teleop Prompts
 * 
 * This command-line utility imports the actual system instructions and tool
 * definitions from `./ai-gateway/openai-realtime-api.js` and allows you to
 * test sending arbitrary text prompts to see how they map to structured tool-call 
 * payloads—without running any robot sockets or services.
 * 
 * Usage:
 *   node test-harness.js
 */

const path = require("path");
const readline = require("readline");

// Load environment variables from .env
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { buildRealtimeVoiceSessionPayload } = require("./ai-gateway/openai-realtime-api");

// ANSI color codes for premium CLI output
const colors = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    dim: "\x1b[2m",
    fgCyan: "\x1b[36m",
    fgGreen: "\x1b[32m",
    fgYellow: "\x1b[33m",
    fgRed: "\x1b[31m",
    fgMagenta: "\x1b[35m",
    fgBlue: "\x1b[34m",
    bgBlue: "\x1b[44m",
    bgBlack: "\x1b[40m",
};

const MODEL = "gpt-4o"; // match the gpt-4o intelligence family used by the web teleop

async function main() {
    console.clear();
    console.log(`${colors.bright}${colors.fgCyan}=============================================================`);
    console.log(`🤖  STRETCH VOICE TELEOP HARNESS TESTER`);
    console.log(`=============================================================${colors.reset}\n`);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.error(`${colors.fgRed}${colors.bright}Error: OPENAI_API_KEY is not set in your .env file!${colors.reset}`);
        console.error(`Please make sure your .env file exists and contains a valid API key.\n`);
        process.exit(1);
    }

    // 1. Build the realtime session payload
    console.log(`${colors.dim}Loading instructions and tool schemas from './ai-gateway/openai-realtime-api.js'...${colors.reset}`);
    let realtimePayload;
    try {
        realtimePayload = buildRealtimeVoiceSessionPayload();
    } catch (err) {
        console.error(`${colors.fgRed}Failed to build realtime voice session payload: ${err.message}${colors.reset}`);
        process.exit(1);
    }

    const { instructions, tools: realtimeTools } = realtimePayload.session;

    console.log(`✅ Loaded ${colors.fgGreen}${realtimeTools.length} voice tools${colors.reset} from the harness:`);
    realtimeTools.forEach(tool => {
        console.log(`   • ${colors.fgCyan}${tool.name}${colors.reset}: ${colors.dim}${tool.description}${colors.reset}`);
    });
    console.log();

    // 2. Convert OpenAI Realtime tool format to standard Chat Completion tool format
    // Realtime format:   { type: "function", name: "...", description: "...", parameters: { ... } }
    // Chat Comp format:  { type: "function", function: { name: "...", description: "...", parameters: { ... } } }
    const chatTools = realtimeTools.map(tool => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        }
    }));

    // Start interactive CLI
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `${colors.bright}${colors.fgMagenta}operator-voice> ${colors.reset}`,
    });

    console.log(`${colors.bright}Type a command for the robot (e.g., "move forward 1 meter", "stow the wrist", "stop").`);
    console.log(`Type ${colors.fgYellow}exit${colors.reset} or ${colors.fgYellow}quit${colors.reset} to leave.\n`);

    rl.prompt();

    let inFlight = 0;
    let shouldExitOnComplete = false;

    rl.on("line", async (line) => {
        const query = line.trim();

        if (query.toLowerCase() === "exit" || query.toLowerCase() === "quit") {
            rl.close();
            return;
        }

        if (!query) {
            rl.prompt();
            return;
        }

        inFlight++;
        console.log(`\n${colors.dim}Sending to OpenAI (model: ${MODEL})...${colors.reset}`);

        try {
            const response = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: MODEL,
                    messages: [
                        { role: "system", content: instructions },
                        { role: "user", content: query },
                    ],
                    tools: chatTools,
                    tool_choice: "auto",
                    temperature: 0.1, // low temperature for more consistent, rule-bound tool mapping
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`\n${colors.fgRed}${colors.bright}OpenAI API Error (HTTP ${response.status}):${colors.reset}`);
                console.error(`${colors.fgRed}${errorText}${colors.reset}\n`);
                inFlight--;
                if (shouldExitOnComplete && inFlight === 0) {
                    process.exit(0);
                }
                rl.prompt();
                return;
            }

            const data = await response.json();
            const message = data.choices?.[0]?.message;

            if (!message) {
                console.log(`\n${colors.fgYellow}No message received in the response.${colors.reset}\n`);
                inFlight--;
                if (shouldExitOnComplete && inFlight === 0) {
                    process.exit(0);
                }
                rl.prompt();
                return;
            }

            // Print textual response if any (though prompt says "Do not respond to the user")
            if (message.content) {
                console.log(`\n${colors.fgYellow}💬 Text response from model:${colors.reset}`);
                console.log(`   "${message.content}"`);
            }

            // Print tool calls (the return payload)
            if (message.tool_calls && message.tool_calls.length > 0) {
                console.log(`\n${colors.fgGreen}${colors.bright}🛠️  Tool Calls (Return Payload):${colors.reset}`);
                message.tool_calls.forEach((toolCall, idx) => {
                    const { name, arguments: argString } = toolCall.function;
                    console.log(`   ${colors.bright}[${idx + 1}] Tool:${colors.reset} ${colors.fgCyan}${name}${colors.reset}`);
                    
                    try {
                        const parsedArgs = JSON.parse(argString);
                        console.log(`       ${colors.bright}Arguments:${colors.reset}`);
                        console.log(JSON.stringify(parsedArgs, null, 4).split("\n").map(l => "       " + l).join("\n"));
                    } catch (e) {
                        console.log(`       ${colors.bright}Arguments (raw):${colors.reset} ${argString}`);
                    }
                });
                console.log();
            } else {
                console.log(`\n${colors.fgYellow}⚠️  No tools were called for this prompt.${colors.reset}`);
                console.log(`   The system instructions/guardrails decided not to invoke any movements.\n`);
            }

        } catch (err) {
            console.error(`\n${colors.fgRed}Network or general error occurred: ${err.message}${colors.reset}\n`);
        }

        inFlight--;
        if (shouldExitOnComplete && inFlight === 0) {
            console.log(`${colors.fgCyan}Exiting voice harness tester. Have a great day! 👋${colors.reset}\n`);
            process.exit(0);
        }
        rl.prompt();
    });

    rl.on("close", () => {
        if (inFlight > 0) {
            shouldExitOnComplete = true;
        } else {
            console.log(`\n${colors.fgCyan}Exiting voice harness tester. Have a great day! 👋${colors.reset}\n`);
            process.exit(0);
        }
    });
}

main();
