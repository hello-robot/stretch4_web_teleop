import React, { forwardRef } from "react";
import InfiniteCarousel, {
    InfiniteCarouselHandle,
} from "./InfiniteCarousel";
import "../../css/SceneCarousel.css";

export interface SceneItem {
    id: string;
    name: string;
    description?: string;
    onClick?: () => void;
    icon?: React.ReactNode;
    enabled: boolean;
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
                    return (
                        <button
                            className={`scene-carousel-item ${isSelected ? "selected" : ""}`}
                            disabled={!scene.enabled}
                            onClick={scene.enabled ? () => { onSceneSelect?.(scene); } : undefined}
                        >
                            <div className="scene-carousel-item-content">
                                {scene.icon && isSelected && (
                                    <div className="scene-carousel-item-icon">
                                        {scene.icon}
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
