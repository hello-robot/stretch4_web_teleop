import React, { forwardRef } from "react";
import CircularProgress from "@mui/material/CircularProgress";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import InfiniteCarousel, {
    InfiniteCarouselHandle,
} from "./InfiniteCarousel";
import "../../css/SceneCarousel.css";

export type SceneItemStatus = "idle" | "loading" | "success" | "error";

export interface SceneItem {
    id: string;
    name: string;
    description?: string;
    onClick?: () => void;
    icon?: React.ReactNode;
    enabled: boolean;
    status?: SceneItemStatus;
}

export type SceneCarouselHandle = InfiniteCarouselHandle;

interface SceneCarouselProps {
    scenes: SceneItem[];
    onSceneSelect?: (scene: SceneItem) => void;
    selectedSceneId?: string;
    onScrollStateChange?: (
        canScrollLeft: boolean,
        canScrollRight: boolean,
    ) => void;
    onPageChange?: (pageIndex: number, totalPages: number) => void;
    footerClassName?: string;
    NavButtonWrapper?: React.ComponentType<{ children: React.ReactNode }>;
}

function statusIcon(status: SceneItemStatus): React.ReactNode {
    switch (status) {
        case "loading":
            return <CircularProgress size={22} thickness={5} color="inherit" />;
        case "success":
            return <CheckCircleIcon fontSize="small" />;
        case "error":
            return <ErrorIcon fontSize="small" />;
        default:
            return null;
    }
}

const SceneCarousel = forwardRef<SceneCarouselHandle, SceneCarouselProps>(
    ({ scenes, onSceneSelect, selectedSceneId, onScrollStateChange, onPageChange, footerClassName, NavButtonWrapper }, ref) => {
        return (
            <InfiniteCarousel<SceneItem>
                ref={ref}
                isHidden={false}
                numOfColumns={3}
                numOfRows={2}
                gap="16px"
                keyExtractor={(scene) => scene.id}
                onScrollStateChange={onScrollStateChange}
                onPageChange={onPageChange}
                className="scene-carousel-container"
                items={scenes}
                showFooter
                footerClassName={footerClassName}
                NavButtonWrapper={NavButtonWrapper}
                renderItem={(scene) => {
                    const isSelected = selectedSceneId === scene.id;
                    const status = scene.status ?? "idle";
                    const hasStatusIcon = status !== "idle";
                    const isDisabled = !scene.enabled || status === "loading";
                    const showIcon =
                        hasStatusIcon || (Boolean(scene.icon) && isSelected);
                    const iconNode = hasStatusIcon
                        ? statusIcon(status)
                        : scene.icon;

                    return (
                        <button
                            className={[
                                "scene-carousel-item",
                                isSelected ? "selected" : "",
                                hasStatusIcon ? `status-${status}` : "",
                            ]
                                .filter(Boolean)
                                .join(" ")}
                            disabled={isDisabled}
                            onClick={
                                isDisabled
                                    ? undefined
                                    : () => {
                                          onSceneSelect?.(scene);
                                      }
                            }
                        >
                            <div className="scene-carousel-item-content">
                                {showIcon && (
                                    <div className="scene-carousel-item-icon">
                                        {iconNode}
                                    </div>
                                )}
                                <div className="scene-carousel-item-name">
                                    {scene.name}
                                </div>
                            </div>
                        </button>
                    );
                }}
            />
        );
    },
);

export default SceneCarousel;
