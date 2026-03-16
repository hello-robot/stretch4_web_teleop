import React, { useMemo, useRef, useState } from "react";

import CheckCircleIcon from "@mui/icons-material/CheckCircle";

import MainMenu from "../basic_components/MainMenu";
import SceneCarousel, {
    SceneCarouselHandle,
    SceneItem,
} from "../basic_components/SceneCarousel";
import MagneticWrapper from "../static_components/MagneticWrapper";
import batteryIcon from "operator/icons/Battery_Footer.svg";
import runStopRunIcon from "operator/icons/RunStop_Run.svg";
import runStopStopIcon from "operator/icons/RunStop_Stop.svg";
import "operator/css/FooterGlobal.css";

interface FooterGlobalProps {
    swipeableViewsIdxSet: React.Dispatch<React.SetStateAction<number>>;
    sceneSelected: string;
    onSceneSelectedChange: React.Dispatch<React.SetStateAction<string>>;
}

const FooterGlobal: React.FC<FooterGlobalProps> = ({
    swipeableViewsIdxSet,
    sceneSelected,
    onSceneSelectedChange,
}) => {
    const [isStopped, isStoppedSet] = useState<boolean>(false);
    const [isMainMenuOpen, isMainMenuOpenSet] = useState<boolean>(false);
    const carouselRef = useRef<SceneCarouselHandle>(null);
    const [canScrollLeft, setCanScrollLeft] = useState(false);
    const [canScrollRight, setCanScrollRight] = useState(false);
    const [currentPage, setCurrentPage] = useState(0);
    const [totalPages, setTotalPages] = useState(0);

    const scenes: SceneItem[] = useMemo(
        () => [
            {
                id: "pilot-mode",
                name: "Pilot Mode",
                description: "TextDescription",
                onClick: () => {
                    swipeableViewsIdxSet(0);
                    onSceneSelectedChange("pilot-mode");
                },
                icon: <CheckCircleIcon />,
                enabled: true
            },
            {
                id: "autonav",
                name: "AutoNav",
                description: "TextDescription",
                onClick: () => {
                    onSceneSelectedChange("autonav");
                    swipeableViewsIdxSet(1);
                },
                icon: <CheckCircleIcon />,
                enabled: true
            },
            {
                id: "finedex-gripper",
                name: "FineDex Gripper",
                description: "TextDescription",
                onClick: () => console.log("You selected 'finedex-gripper'"),
                icon: <CheckCircleIcon />,
                enabled: false
            },
            {
                id: "autodock",
                name: "AutoDock",
                description: "TextDescription",
                onClick: () => console.log("You selected 'autodock'"),
                icon: <CheckCircleIcon />,
                enabled: false
            },
            {
                id: "feeding",
                name: "Feeding",
                description: "TextDescription",
                onClick: () => console.log("You selected 'feeding'"),
                icon: <CheckCircleIcon />,
                enabled: false
            },
            {
                id: "settings",
                name: "Settings",
                description: "TextDescription",
                onClick: () => console.log("You selected 'settings'"),
                icon: <CheckCircleIcon />,
                enabled: false
            },
        ],
        [onSceneSelectedChange, swipeableViewsIdxSet]
    );

    const handleSceneSelect = (scene: SceneItem) => {
        onSceneSelectedChange(scene.id);
        scene.onClick?.();
        isMainMenuOpenSet(false);
    };

    const sceneNameCurrent = scenes.find(
        (scene) => scene.id === sceneSelected
    )?.name;

    return (
        <div className="footer-global">
            <div className="battery-container">
                <img src={batteryIcon} alt="Battery" className="battery" />
            </div>
            <div className="scene-menu-button-container">
                <button
                    className="scene-menu-button"
                    onPointerUp={() => isMainMenuOpenSet(true)}
                >
                    {sceneNameCurrent}
                    <div className="fancy-border" />
                </button>
                <MainMenu
                    isOpen={isMainMenuOpen}
                    handleClose={() => isMainMenuOpenSet(false)}
                    title="Main Menu"
                    children={
                        <SceneCarousel
                            ref={carouselRef}
                            scenes={scenes}
                            onSceneSelect={handleSceneSelect}
                            selectedSceneId={sceneSelected}
                            onScrollStateChange={(left, right) => {
                                setCanScrollLeft(left);
                                setCanScrollRight(right);
                            }}
                            onPageChange={(page, total) => {
                                setCurrentPage(page);
                                setTotalPages(total);
                            }}
                        />
                    }
                    footer={
                        <div className="scene-carousel-footer">
                            <MagneticWrapper>
                                <button
                                    className="scene-carousel-footer-button"
                                    onClick={() =>
                                        carouselRef.current?.scrollLeft()
                                    }
                                    disabled={!canScrollLeft}
                                    aria-label="Previous page"
                                >
                                    <svg
                                        width="24"
                                        height="24"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        xmlns="http://www.w3.org/2000/svg"
                                    >
                                        <path
                                            d="M15 18L9 12L15 6"
                                            stroke="currentColor"
                                            strokeWidth="2"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                        />
                                    </svg>
                                </button>
                            </MagneticWrapper>
                            <div className="scene-carousel-dots">
                                {Array.from({ length: totalPages }).map(
                                    (_, idx) => (
                                        <span
                                            key={idx}
                                            className={`scene-carousel-dot ${idx === currentPage
                                                ? "active"
                                                : ""
                                                }`}
                                        />
                                    )
                                )}
                            </div>
                            <MagneticWrapper>
                                <button
                                    className="scene-carousel-footer-button"
                                    onClick={() =>
                                        carouselRef.current?.scrollRight()
                                    }
                                    disabled={!canScrollRight}
                                    aria-label="Next page"
                                >
                                    <svg
                                        width="24"
                                        height="24"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        xmlns="http://www.w3.org/2000/svg"
                                    >
                                        <path
                                            d="M9 18L15 12L9 6"
                                            stroke="currentColor"
                                            strokeWidth="2"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                        />
                                    </svg>
                                </button>
                            </MagneticWrapper>
                        </div>
                    }
                />
            </div>
            <div className="run-stop-container">
                <button
                    onClick={() => isStoppedSet(!isStopped)}
                    type="button"
                    className={`run-stop-button ${isStopped ? "stopped" : "running"}`}
                    aria-label={isStopped ? "Run" : "Stop"}
                >
                    <img
                        src={isStopped ? runStopStopIcon : runStopRunIcon}
                        alt=""
                        aria-hidden="true"
                        className="icon"
                    />
                </button>
            </div>
        </div>
    );
};

export default FooterGlobal;
