import React, {
    forwardRef,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useState,
} from "react";
import "../../css/SceneCarousel.css";

export interface SceneItem {
    id: string;
    name: string;
    description?: string;
    onClick?: () => void;
    icon?: React.ReactNode;
    enabled: boolean;
}

export interface SceneCarouselHandle {
    scrollLeft: () => void;
    scrollRight: () => void;
    canScrollLeft: boolean;
    canScrollRight: boolean;
}

interface SceneCarouselProps {
    scenes: SceneItem[];
    onSceneSelect?: (scene: SceneItem) => void;
    selectedSceneId?: string;
    onScrollStateChange?: (
        canScrollLeft: boolean,
        canScrollRight: boolean
    ) => void;
    onPageChange?: (pageIndex: number, totalPages: number) => void;
}

const ITEMS_PER_PAGE = 6; // 3 columns × 2 rows
const TRANSITION_MS = 400;

const SceneCarousel = forwardRef<SceneCarouselHandle, SceneCarouselProps>(
    (
        {
            scenes,
            onSceneSelect,
            selectedSceneId,
            onScrollStateChange,
            onPageChange,
        },
        ref
    ) => {
        const trackRef = useRef<HTMLDivElement>(null);
        const [currentIndex, setCurrentIndex] = useState(1); // Start on first real page
        const [isAnimating, setIsAnimating] = useState(false);
        const onPageChangeRef = useRef(onPageChange);

        useEffect(() => {
            onPageChangeRef.current = onPageChange;
        }, [onPageChange]);

        // Group scenes into pages of 6 items each
        const pages = useMemo(() => {
            const result: SceneItem[][] = [];
            for (let i = 0; i < scenes.length; i += ITEMS_PER_PAGE) {
                result.push(scenes.slice(i, i + ITEMS_PER_PAGE));
            }
            return result;
        }, [scenes]);

        // Build infinite track [last, ...pages, first]
        const infinitePages = useMemo(() => {
            if (pages.length === 0) return [];
            return [pages[pages.length - 1], ...pages, pages[0]];
        }, [pages]);

        // Update scrollability state
        useEffect(() => {
            const scrollable = pages.length > 1;
            onScrollStateChange?.(scrollable, scrollable);
        }, [pages.length, onScrollStateChange]);

        // Reset to first real page when page count changes
        useEffect(() => {
            setCurrentIndex(pages.length > 0 ? 1 : 0);
            setIsAnimating(false);
            if (trackRef.current) {
                trackRef.current.style.transition = "none";
            }
            if (pages.length > 0) {
                onPageChangeRef.current?.(0, pages.length);
            }
        }, [pages.length]);

        // Jump without animation
        const jumpToIndex = (index: number) => {
            const track = trackRef.current;
            if (!track) return;
            track.style.transition = "none";
            setCurrentIndex(index);
            // Force reflow before re-enabling transition
            void track.offsetHeight;
            track.style.transition = `transform ${TRANSITION_MS}ms ease`;
        };

        const goToIndex = (index: number) => {
            if (isAnimating || pages.length <= 1) return;
            setIsAnimating(true);
            setCurrentIndex(index);
        };

        const handleNext = () => goToIndex(currentIndex + 1);
        const handlePrev = () => goToIndex(currentIndex - 1);

        const handleTransitionEnd = () => {
            if (pages.length === 0) {
                setIsAnimating(false);
                return;
            }
            const lastRealIndex = pages.length;
            let resolvedIndex = currentIndex;
            if (currentIndex === 0) {
                jumpToIndex(lastRealIndex);
                resolvedIndex = lastRealIndex;
            } else if (currentIndex === lastRealIndex + 1) {
                jumpToIndex(1);
                resolvedIndex = 1;
            }
            setIsAnimating(false);

            // Map track index to real page index (0-based for real pages)
            const realIndex =
                resolvedIndex === 0
                    ? lastRealIndex - 1
                    : resolvedIndex === lastRealIndex + 1
                        ? 0
                        : resolvedIndex - 1;
            onPageChangeRef.current?.(realIndex, pages.length);
        };

        useImperativeHandle(
            ref,
            () => ({
                scrollLeft: handlePrev,
                scrollRight: handleNext,
                canScrollLeft: pages.length > 1,
                canScrollRight: pages.length > 1,
            }),
            [pages.length, currentIndex, isAnimating]
        );

        const trackStyle: React.CSSProperties = {
            transform: `translateX(-${currentIndex * 100}%)`,
            transition: isAnimating
                ? `transform ${TRANSITION_MS}ms ease`
                : "none",
        };

        return (
            <div className="scene-carousel-container" >
                <div className="scene-carousel-viewport" >
                    <div
                        ref={trackRef}
                        className="scene-carousel-track"
                        style={trackStyle}
                        onTransitionEnd={handleTransitionEnd}
                    >
                        {
                            infinitePages.map((page, pageIndex) => (
                                <div
                                    key={`${pageIndex}-${page[0]?.id || pageIndex}`}
                                    className="scene-carousel-page"
                                >
                                    {
                                        page.map((scene) => {
                                            const isSelected =
                                                selectedSceneId === scene.id;
                                            return (
                                                <button
                                                    key={scene.id}
                                                    className={`scene-carousel-item ${isSelected ? "selected" : ""
                                                        }`
                                                    }
                                                    disabled={!scene.enabled}
                                                    onClick={scene.enabled ? () => { onSceneSelect?.(scene) } : null}
                                                >
                                                    <div className="scene-carousel-item-content" >
                                                        {
                                                            scene.icon && isSelected && (
                                                                <div className="scene-carousel-item-icon">
                                                                    {scene.icon}
                                                                </div>
                                                            )
                                                        }
                                                        < div className="scene-carousel-item-name" >
                                                            {scene.name}
                                                        </div>
                                                    </div>
                                                </button>
                                            );
                                        })}
                                </div>
                            ))}
                    </div>
                </div>
            </div >
        );
    }
);

export default SceneCarousel;
