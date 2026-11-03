import { useEffect, useState } from "react";

/**
 * Rails confirmed deployed. Only a positive answer is kept: a rail can be
 * published while a dashboard is open, and a cached refusal would outlive it.
 */
const deployed = new Map<string, boolean>();

/** Probes in flight, so several cards on one rail share a single request. */
const inFlight = new Map<string, Promise<boolean>>();

/**
 * Check whether a rail is deployed by fetching the manifest it ships with.
 *
 * A request that throws counts as unavailable: a network failure cannot be
 * told apart from a missing rail, and refusing to connect is the recoverable
 * error of the two.
 *
 * @param rail Release tag naming the rail, as published in build.rail.
 * @returns True when the rail's manifest is served.
 */
export const probeRail = (rail: string): Promise<boolean> => {
    if (deployed.get(rail)) return Promise.resolve(true);

    const pending = inFlight.get(rail);
    if (pending) return pending;

    const probe = fetch(`/r/${rail}/manifest.json`, { cache: "no-store" })
        .then((response) => response.ok)
        .catch(() => false)
        .then((ok) => {
            if (ok) deployed.set(rail, true);
            inFlight.delete(rail);
            return ok;
        });

    inFlight.set(rail, probe);
    return probe;
};

/**
 * Whether the rail a card routes to is deployed.
 *
 * A null rail is the unversioned page, which needs no probe and answers true
 * on the first render. A rail already confirmed answers true on the first
 * render too, so a dashboard of robots on one release renders once.
 *
 * @param rail Release tag to check, or null for the unversioned page.
 * @returns True or false once known, null while a probe is outstanding.
 */
export const useRailAvailable = (rail: string | null): boolean | null => {
    const [available, availableSet] = useState<boolean | null>(() =>
        rail === null ? true : deployed.get(rail) ?? null
    );

    useEffect(() => {
        if (rail === null) {
            availableSet(true);
            return;
        }
        if (deployed.get(rail)) {
            availableSet(true);
            return;
        }

        availableSet(null);
        let cancelled = false;
        probeRail(rail).then((ok) => {
            if (!cancelled) availableSet(ok);
        });
        return () => {
            cancelled = true;
        };
    }, [rail]);

    return available;
};
