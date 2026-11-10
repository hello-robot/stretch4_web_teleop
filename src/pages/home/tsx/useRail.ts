import { useEffect, useState } from "react";

/**
 * What a probe established about a rail.
 *
 * "absent" is a claim: the origin answered, and answered that nothing is
 * served there. "unknown" is the absence of a claim — the request never
 * arrived, or came back with a fault that says nothing about whether the rail
 * exists. Collapsing the two is what let a flaky network read as a withdrawn
 * release.
 */
export type RailProbe = "deployed" | "absent" | "unknown";

/** Statuses that are evidence a rail is genuinely not published at this origin. */
const ABSENT_STATUS = new Set([404, 410]);

/** How long to wait before the single retry an inconclusive probe gets. */
const RETRY_DELAY_MS = 1000;

/**
 * Rails confirmed deployed. Only a positive answer is kept: a rail can be
 * published while a dashboard is open, and a cached refusal would outlive it.
 */
const deployed = new Map<string, boolean>();

/** Probes in flight, so several cards on one rail share a single request. */
const inFlight = new Map<string, Promise<RailProbe>>();

/**
 * Ask the origin once whether a rail is served.
 *
 * Never rejects: a thrown fetch is an answerless probe, not a failure the
 * caller must handle.
 *
 * @param rail Release tag naming the rail.
 * @returns What this single attempt established.
 */
const probeOnce = async (rail: string): Promise<RailProbe> => {
    try {
        const response = await fetch(`/r/${rail}/manifest.json`, {
            cache: "no-store",
        });
        if (response.ok) return "deployed";
        return ABSENT_STATUS.has(response.status) ? "absent" : "unknown";
    } catch {
        // Offline, DNS, CORS, a channel still warming: all answerless.
        return "unknown";
    }
};

/**
 * Check whether a rail is deployed by fetching the manifest it ships with.
 *
 * An inconclusive probe is retried once, because a transient failure is common
 * and a second silence is no more informative than the first. Only "deployed"
 * is cached; "absent" can be undone by a deploy while the page is open, and
 * "unknown" was never an answer to cache.
 *
 * @param rail Release tag naming the rail, as published in build.rail.
 * @returns What the origin established about the rail.
 */
export const probeRail = (rail: string): Promise<RailProbe> => {
    if (deployed.get(rail)) return Promise.resolve<RailProbe>("deployed");

    const pending = inFlight.get(rail);
    if (pending) return pending;

    const probe = probeOnce(rail)
        .then(async (first) => {
            if (first !== "unknown") return first;
            await new Promise((resolve) =>
                setTimeout(resolve, RETRY_DELAY_MS),
            );
            return probeOnce(rail);
        })
        .then((result) => {
            if (result === "deployed") deployed.set(rail, true);
            inFlight.delete(rail);
            return result;
        });

    inFlight.set(rail, probe);
    return probe;
};

/**
 * What is known about a rail without asking the origin.
 *
 * @param rail Release tag to check, or null for the unversioned page.
 * @returns True for the unversioned page and for a rail already confirmed
 *     deployed, null for a rail that still needs a probe.
 */
const settled = (rail: string | null): boolean | null =>
    rail === null ? true : deployed.get(rail) ?? null;

/**
 * Whether the rail a card routes to is deployed.
 *
 * A null rail is the unversioned page, which needs no probe and answers true
 * on the first render. A rail already confirmed answers true on the first
 * render too, so a dashboard of robots on one release renders once.
 *
 * False means the origin said the rail is not there, so a card may state that
 * as fact. A probe that established nothing answers true rather than false:
 * the card has no grounds to withhold Connect or to claim a release was never
 * deployed, and a page that turns out to be missing says so in the browser.
 *
 * An answer is kept with the rail it is about. A card that moves to another
 * rail, as one falling back to the stable release does, would otherwise read
 * the previous rail's answer for the render before its own probe starts.
 *
 * @param rail Release tag to check, or null for the unversioned page.
 * @returns True or false once known, null while a probe is outstanding.
 */
export const useRailAvailable = (rail: string | null): boolean | null => {
    const [answer, answerSet] = useState<{
        rail: string | null;
        available: boolean | null;
    }>(() => ({ rail, available: settled(rail) }));

    useEffect(() => {
        const known = settled(rail);
        answerSet({ rail, available: known });
        if (rail === null || known !== null) return;

        let cancelled = false;
        probeRail(rail).then((result) => {
            if (!cancelled) {
                answerSet({ rail, available: result !== "absent" });
            }
        });
        return () => {
            cancelled = true;
        };
    }, [rail]);

    return answer.rail === rail ? answer.available : settled(rail);
};
