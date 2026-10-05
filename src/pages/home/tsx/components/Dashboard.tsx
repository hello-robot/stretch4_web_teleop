import Snackbar from "@mui/material/Snackbar";
import "operator/css/MobileOperator.css";
import "home/css/Dashboard.css";
import React, { useEffect, useState } from "react";
import { loginHandler } from "../index";
import { compareOnlineFirst, MapIndex, RobotRecord } from "../robotModel";
import { RobotCard } from "./RobotCard";
import { UserAvatar } from "./UserAvatar";

/** Spinner stays up at least this long, even when the robot list is already in. */
const SPINNER_MIN_MS = 1000;

export const Dashboard = () => {
    const [robots, robotsSet] = useState<Record<string, RobotRecord>>({});
    const [maps, mapsSet] = useState<MapIndex>({});
    const [robotsLoaded, robotsLoadedSet] = useState(false);
    const [spinnerHeld, spinnerHeldSet] = useState(true);
    const [errorMessage, errorMessageSet] = useState<string | null>(null);

    useEffect(() => {
        const stopRooms = loginHandler.listRooms((nextRobots) => {
            robotsLoadedSet(true);
            robotsSet(nextRobots);
        });
        loginHandler.getUserMaps("", (result) => mapsSet(result || {}));
        const timer = window.setTimeout(() => spinnerHeldSet(false), SPINNER_MIN_MS);
        return () => {
            stopRooms();
            window.clearTimeout(timer);
        };
    }, []);

    const activeRobots = Object.entries(robots)
        .filter(([, robot]) => robot?.is_active)
        .sort(([, a], [, b]) => compareOnlineFirst(a, b));

    return (
        <div className="hr-page">
            <header className="hr-header">
                <div className="hr-header__top">
                    <h1 className="hr-wordmark">hello robot</h1>
                    <UserAvatar onError={errorMessageSet} />
                </div>
                <div className="hr-wordmark__sub">CLOUD</div>
            </header>

            <main className="hr-robots">
                {!robotsLoaded || spinnerHeld ? (
                    <div className="hr-robots__loading" aria-busy="true" aria-label="Loading robots">
                        <div className="loader" aria-hidden="true" />
                    </div>
                ) : activeRobots.length === 0 ? (
                    <p className="hr-empty">No robots are assigned to this account.</p>
                ) : (
                    activeRobots.map(([uid, robot], index) => (
                        <RobotCard
                            key={uid}
                            uid={uid}
                            robot={robot}
                            maps={maps}
                            onError={errorMessageSet}
                            revealIndex={index}
                        />
                    ))
                )}
            </main>

            <Snackbar
                anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
                open={errorMessage !== null}
                autoHideDuration={6000}
                onClose={() => errorMessageSet(null)}
                message={errorMessage ?? ""}
                ContentProps={{ sx: { background: "#b3261e", color: "#fff" } }}
            />
        </div>
    );
};
