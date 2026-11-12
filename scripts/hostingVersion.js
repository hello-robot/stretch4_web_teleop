/**
 * Publish a Hosting version additively with a retention filter.
 *
 * A Hosting version is the complete file set, so a standard CLI deploy
 * requires every file that must survive to be present on local disk. Cloning
 * the version that is already live — filtered to keep only the /r/<tag>/
 * prefixes listed in release.json — and populating the new build on top lifts
 * that requirement while ensuring retired or temporary rails and stale root
 * assets are pruned automatically.
 *
 * With carryRoot the clone also keeps every path outside /r/, so the lobby and
 * /operator/ in the new version are the live version's own files.
 *
 * On a brand-new Firebase project where the live channel serves no version
 * yet, publishAdditively falls back to creating a fresh version.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const {
    getChannel,
    createChannel,
    updateChannelTtl,
    createVersion,
    updateVersion,
    createRelease,
} = require("firebase-tools/lib/hosting/api");
const { Client } = require("firebase-tools/lib/apiv2");
const { hostingApiOrigin } = require("firebase-tools/lib/api");
const operationPoller = require("firebase-tools/lib/operation-poller");
const {
    selectAccount,
    setActiveAccount,
} = require("firebase-tools/lib/auth");
const { getFirebaseProject } = require("firebase-tools/lib/management/projects");
const { requireAuth } = require("firebase-tools/lib/requireAuth");

/** Paths per :populateFiles call, matching the CLI's own batch size. */
const POPULATE_BATCH = 1000;

/** Preview channel lifetime: 30 days in milliseconds. */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const defaultRepoRoot = path.join(__dirname, "..");

/**
 * Authenticate for Hosting API calls using either a stored CLI login or
 * GOOGLE_APPLICATION_CREDENTIALS / application-default credentials in CI.
 *
 * requireAuth reads options.user and options.tokens when an interactive login
 * exists in the credential store, and falls back to autoAuth() (which reads
 * GOOGLE_APPLICATION_CREDENTIALS) when no interactive account is present.
 * When `projectId` is given, verifies the credentials against the project.
 *
 * @param {string} [projectId] Project ID to verify access against.
 * @returns {Promise<string>} The authenticated account or service account name.
 * @throws {Error} When neither a stored login nor service-account credentials work.
 */
async function authenticate(projectId) {
    const options = {};
    const account = selectAccount(undefined, process.cwd());
    if (account) {
        setActiveAccount(options, account);
    }
    try {
        const email = await requireAuth(options);
        if (projectId) {
            await getFirebaseProject(projectId);
        }
        return email ?? account?.user?.email ?? "service account";
    } catch (error) {
        const detail = error.original?.message
            ? `${error.message} (${error.original.message})`
            : error.message;
        throw new Error(
            "not authenticated to Firebase. Run ./node_modules/.bin/firebase login --reauth " +
                "or set GOOGLE_APPLICATION_CREDENTIALS.\n" +
                `          (${detail})`,
        );
    }
}

/**
 * Hosting site id behind an origin.
 *
 * @param {string} origin Origin the site is served from.
 * @returns {string|null} Site id, or null for a custom domain.
 */
function siteFromOrigin(origin) {
    try {
        const { hostname } = new URL(origin);
        if (!/\.(web\.app|firebaseapp\.com)$/.test(hostname)) return null;
        return hostname.split(".")[0].split("--")[0];
    } catch {
        return null;
    }
}

/**
 * Escape a literal string for use inside a regular expression.
 *
 * @param {string} value Literal string to escape.
 * @returns {string} Escaped regex fragment.
 */
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a relative path inside dist-firebase should be ignored per
 * firebase.json hosting.ignore rules (dotfiles, node_modules, firebase.json).
 *
 * @param {string} name Entry basename.
 * @returns {boolean} True when the entry must not be uploaded.
 */
function isIgnoredEntry(name) {
    return (
        name.startsWith(".") ||
        name === "node_modules" ||
        name === "firebase.json"
    );
}

/**
 * Every deployable file under a directory, as served paths mapped to local paths.
 *
 * @param {string} dir Directory to walk.
 * @returns {Record<string, string>} Served path to local path.
 */
function servedFiles(dir) {
    const found = {};
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (isIgnoredEntry(entry.name)) continue;
            const local = path.join(current, entry.name);
            if (entry.isDirectory()) walk(local);
            else if (entry.isFile()) {
                const rel = path.relative(dir, local).split(path.sep).join("/");
                found[`/${rel}`] = local;
            }
        }
    };
    walk(dir);
    return found;
}

/**
 * Convert firebase.json hosting.headers into the ServingConfig format expected
 * by the Firebase Hosting REST API on version finalization.
 *
 * @param {string} [repoRoot] Repository root containing firebase.json.
 * @returns {{headers?: Array<{glob?: string, regex?: string, headers: Record<string, string>}>}}
 *     Converted version config object.
 */
function hostingVersionConfig(repoRoot = defaultRepoRoot) {
    const configPath = path.join(repoRoot, "firebase.json");
    if (!fs.existsSync(configPath)) return {};
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const headerRules = raw?.hosting?.headers;
    if (!Array.isArray(headerRules) || headerRules.length === 0) return {};

    const headers = headerRules.map((rule) => {
        const map = {};
        for (const { key, value } of rule.headers || []) {
            map[key] = value;
        }
        const pattern = rule.regex
            ? { regex: rule.regex }
            : { glob: rule.source ?? rule.glob };
        return { ...pattern, headers: map };
    });
    return { headers };
}

/**
 * Hosting's content hash: SHA256 of the gzipped bytes.
 *
 * @param {string} file Local path.
 * @returns {{hash: string, body: Buffer}} Hash and the compressed content.
 */
function contentHash(file) {
    const body = zlib.gzipSync(fs.readFileSync(file), { level: 9 });
    return {
        hash: crypto.createHash("sha256").update(body).digest("hex"),
        body,
    };
}

/**
 * Whether a path is already served at an origin.
 *
 * Used to confirm a rail this run did not assemble is nonetheless on the site,
 * so the clone will carry it across.
 *
 * @param {string} origin Origin to ask.
 * @param {string} servedPath Path to look for.
 * @returns {Promise<boolean>} True when it answers 200.
 */
async function servedAt(origin, servedPath) {
    try {
        const response = await fetch(`${origin}${servedPath}`, {
            method: "HEAD",
            cache: "no-store",
        });
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Build the regex inclusion list that retains only `/r/<tag>/` trees when
 * cloning a Hosting version.
 *
 * Hosting keeps a path only when a regex matches the whole of it, so each
 * pattern runs to the end of the path.
 *
 * @param {string[]} retainedRails Rail tags to preserve from the source version.
 * @returns {string[]} Whole-path regular expressions with regex
 *     metacharacters in the tags escaped.
 */
function railCloneRegexes(retainedRails) {
    return retainedRails.map((rail) => `^/r/${escapeRegex(rail)}/.*$`);
}

/**
 * Clone filter matching the whole of every served path outside /r/.
 *
 * Hosting evaluates clone filters with RE2, which has no lookahead, so the
 * exclusion of /r/ is spelled as alternatives.
 */
const ROOT_CLONE_REGEX = "^/(r|[^r].*|r[^/].*)$";

/**
 * Regex inclusion list for cloning a Hosting version.
 *
 * @param {string[]} retainedRails Rail tags to preserve from the source version.
 * @param {boolean} [carryRoot=false] Also preserve every path outside /r/.
 * @returns {string[]} Whole-path RE2 regular expressions.
 */
function cloneIncludeRegexes(retainedRails, carryRoot = false) {
    const rails = railCloneRegexes(retainedRails);
    return carryRoot ? [ROOT_CLONE_REGEX, ...rails] : rails;
}

/**
 * Request body for a versions:clone call.
 *
 * @param {string} sourceVersion Resource name of the version to clone.
 * @param {string[]} retainedRails Rail tags to preserve from the source version.
 * @param {boolean} [carryRoot=false] Also preserve every path outside /r/.
 * @returns {{sourceVersion: string, finalize: boolean,
 *     include?: {regexes: string[]}}} The request body; include is omitted
 *     when nothing is filtered.
 */
function cloneRequestBody(sourceVersion, retainedRails, carryRoot = false) {
    const regexes = cloneIncludeRegexes(retainedRails, carryRoot);
    return {
        sourceVersion,
        finalize: false,
        ...(regexes.length > 0 ? { include: { regexes } } : {}),
    };
}

/**
 * Served paths that lie outside the rails tree.
 *
 * @param {string[]} paths Served paths, each beginning with a slash.
 * @returns {string[]} The paths not under /r/, sorted.
 */
function pathsOutsideRails(paths) {
    return paths.filter((served) => !served.startsWith("/r/")).sort();
}

/**
 * Resource name of the version the live channel serves.
 *
 * @param {string} siteId Hosting site id.
 * @returns {Promise<string|null>} The version name, or null when the site has
 *     no live release.
 * @throws {Error} When not authenticated to Firebase.
 */
async function liveVersionName(siteId) {
    await authenticate();
    const live = await getChannel("-", siteId, "live");
    return live?.release?.version?.name ?? null;
}

/**
 * Clone a Hosting version server-side, filtering the clone to retain only the
 * /r/<tag>/ trees for the specified rails and, with carryRoot, every path
 * outside /r/.
 *
 * A rail absent from retainedRails is omitted from the include filter, so it
 * is pruned in the new version.
 *
 * @param {Client} api Authenticated Hosting v1beta1 client.
 * @param {string} siteId Hosting site id.
 * @param {string} sourceVersion Resource name of the version to clone.
 * @param {string[]} retainedRails Rail tags to preserve from the source version.
 * @param {boolean} [carryRoot=false] Also preserve every path outside /r/.
 * @returns {Promise<string>} Resource name of the cloned version.
 * @throws {Error} When the clone operation returns no version name.
 */
async function cloneFilteredVersion(
    api,
    siteId,
    sourceVersion,
    retainedRails,
    carryRoot = false,
    pollOperation = (opts) => operationPoller.pollOperation(opts),
) {
    const body = cloneRequestBody(sourceVersion, retainedRails, carryRoot);
    const res = await api.post(
        `/projects/-/sites/${siteId}/versions:clone`,
        body,
    );
    const cloned = await pollOperation({
        apiOrigin: hostingApiOrigin(),
        apiVersion: "v1beta1",
        operationResourceName: res.body.name,
        masterTimeout: 600000,
    });
    if (!cloned?.name) throw new Error("clone returned no version");
    return cloned.name;
}

const defaultPublishDeps = {
    authenticate,
    createChannel,
    createClient: (opts) => new Client(opts),
    createRelease,
    createVersion,
    getChannel,
    pollOperation: (opts) => operationPoller.pollOperation(opts),
    repoRoot: defaultRepoRoot,
    updateChannelTtl,
    updateVersion,
};

/**
 * Publish a directory onto a Hosting channel (live or preview), carrying over
 * retained rails from the current live version when one exists.
 *
 * With carryRoot the live version's paths outside /r/ are carried too, and
 * distDir may hold nothing but rails.
 *
 * @param {object} args Publish arguments.
 * @param {string} args.origin Origin the site is served from.
 * @param {string} args.distDir Directory to publish.
 * @param {string|null} [args.site] Site id, when the origin cannot name it.
 * @param {string[]} [args.retainedRails] Rails to retain from the live version clone.
 * @param {boolean} [args.carryRoot] Carry the lobby and /operator/ from the
 *     live version instead of publishing them from distDir.
 * @param {string} [args.channel] Target channel id ("live" by default).
 * @param {(message: string, detail?: string) => void} args.report Progress sink.
 * @param {object} [deps] Optional API collaborators for offline testing.
 * @returns {Promise<{version: string, url: string|null}>} Released version and channel URL.
 * @throws {Error} When the site cannot be identified, upload fails, or
 *     carryRoot is set and distDir holds a path outside /r/ or the site has
 *     no live version.
 */
async function publishAdditively(
    {
        origin,
        distDir,
        site,
        retainedRails = [],
        carryRoot = false,
        channel = "live",
        report,
    },
    deps = {},
) {
    const runtime = { ...defaultPublishDeps, ...deps };
    const files = servedFiles(distDir);
    if (carryRoot) {
        // populateFiles overwrites any path it is handed, so a root path here
        // would replace the file the clone carried.
        const outside = pathsOutsideRails(Object.keys(files));
        if (outside.length > 0) {
            throw new Error(
                `${distDir} holds ${outside.length} path(s) outside /r/ ` +
                    `(${outside.slice(0, 3).join(", ")}); publishing them ` +
                    "would replace the lobby this release carries unchanged"
            );
        }
    }

    const siteId = site ?? siteFromOrigin(origin);
    if (!siteId) {
        throw new Error(
            `cannot read a Hosting site id from ${origin}; pass --site`,
        );
    }

    const email = await runtime.authenticate();
    report("Authenticated to Hosting", email);

    const api = runtime.createClient({
        urlPrefix: hostingApiOrigin(),
        apiVersion: "v1beta1",
        auth: true,
    });

    const live = await runtime.getChannel("-", siteId, "live");
    const source = live?.release?.version?.name;
    if (carryRoot && !source) {
        throw new Error(
            `${siteId} has no live version to carry the lobby from`
        );
    }
    let version;
    if (source && (carryRoot || retainedRails.length > 0)) {
        report(
            carryRoot
                ? "Cloning the lobby, /operator/ and retained rails from the live version"
                : "Cloning retained rails from the live version",
            `${source.split("/").pop()} (${retainedRails.join(", ")})`,
        );
        version = await cloneFilteredVersion(
            api,
            siteId,
            source,
            retainedRails,
            carryRoot,
            runtime.pollOperation,
        );
    } else {
        report(
            "Creating a fresh Hosting version",
            source ? "no prior rails requested" : `initial version on ${siteId}`,
        );
        version = await runtime.createVersion(siteId, { status: "CREATED" });
        if (!version) throw new Error("createVersion returned no version");
    }

    const hashes = {};
    const bodies = {};
    for (const [served, local] of Object.entries(files)) {
        const { hash, body } = contentHash(local);
        hashes[served] = hash;
        bodies[hash] = body;
    }

    const paths = Object.keys(hashes);
    const required = [];
    let uploadUrl;
    for (let i = 0; i < paths.length; i += POPULATE_BATCH) {
        const batch = Object.fromEntries(
            paths.slice(i, i + POPULATE_BATCH).map((p) => [p, hashes[p]]),
        );
        const res = await api.post(`/${version}:populateFiles`, {
            files: batch,
        });
        uploadUrl = res.body.uploadUrl ?? uploadUrl;
        required.push(...(res.body.uploadRequiredHashes ?? []));
    }
    report(
        "Populated build into Hosting version",
        `${paths.length} paths, ${required.length} needing upload`,
    );

    if (required.length > 0) {
        const uploader = runtime.createClient({
            urlPrefix: uploadUrl,
            auth: true,
        });
        for (const hash of required) {
            const uploadRes = await uploader.request({
                method: "POST",
                path: `/${hash}`,
                body: bodies[hash],
                resolveOnHTTPError: true,
                responseType: "stream",
            });
            if (uploadRes.status !== 200) {
                const chunks = [];
                if (uploadRes.body) {
                    for await (const chunk of uploadRes.body) {
                        chunks.push(Buffer.from(chunk));
                    }
                }
                const detail = Buffer.concat(chunks).toString("utf8").trim();
                throw new Error(
                    `upload failed for ${hash} (HTTP ${uploadRes.status})` +
                        (detail ? `: ${detail}` : ""),
                );
            }
            uploadRes.body?.resume?.();
        }
    }

    const config = hostingVersionConfig(runtime.repoRoot);
    await runtime.updateVersion(siteId, version.split("/").pop(), {
        status: "FINALIZED",
        ...(Object.keys(config).length > 0 ? { config } : {}),
    });

    let channelUrl = null;
    if (channel !== "live") {
        const existing = await runtime.getChannel("-", siteId, channel);
        if (!existing) {
            const created = await runtime.createChannel(
                "-",
                siteId,
                channel,
                THIRTY_DAYS_MS,
            );
            channelUrl = created?.url ?? null;
        } else {
            const updated = await runtime.updateChannelTtl(
                "-",
                siteId,
                channel,
                THIRTY_DAYS_MS,
            );
            channelUrl = updated?.url ?? existing?.url ?? null;
        }
    }

    await runtime.createRelease(siteId, channel, version, {});
    report(
        channel === "live"
            ? "Released to the live channel"
            : `Released to preview channel ${channel}`,
        channelUrl
            ? `${version.split("/").pop()} -> ${channelUrl}`
            : version.split("/").pop(),
    );
    return { version, url: channelUrl };
}

module.exports = {
    ROOT_CLONE_REGEX,
    authenticate,
    cloneIncludeRegexes,
    cloneRequestBody,
    hostingVersionConfig,
    liveVersionName,
    pathsOutsideRails,
    publishAdditively,
    railCloneRegexes,
    servedAt,
    servedFiles,
    siteFromOrigin,
};
