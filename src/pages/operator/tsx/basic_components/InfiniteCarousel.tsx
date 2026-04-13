import React, {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import "../../css/InfiniteCarousel.css";

export interface InfiniteCarouselHandle {
    scrollLeft: () => void;
    scrollRight: () => void;
    canScrollLeft: boolean;
    canScrollRight: boolean;
}

interface InfiniteCarouselProps<T> {
    /** Whether the carousel is hidden. @default false */
    isHidden: boolean;
    /** The full list of items to paginate through. */
    items: T[];
    /** Number of columns per page. */
    numOfColumns: number;
    /** Number of rows per page. */
    numOfRows: number;
    /**
     * Override items per page. Defaults to `numOfColumns * numOfRows`.
     * Useful when you want a different count than the grid implies.
     */
    itemsPerPage?: number;
    /** Render function for each item. */
    renderItem: (item: T, index: number) => React.ReactNode;
    /** Extract a unique key for each item. */
    keyExtractor: (item: T, index: number) => string;
    /** Transition duration in milliseconds. @default 400 */
    transitionMs?: number;
    /** CSS transition timing function for page slides. @default "ease-out" */
    transitionTimingFunction?: React.CSSProperties["transitionTimingFunction"];
    /** Called when scroll availability changes. */
    onScrollStateChange?: (
        canScrollLeft: boolean,
        canScrollRight: boolean,
    ) => void;
    /** Called when the visible page changes. */
    onPageChange?: (pageIndex: number, totalPages: number) => void;
    /** Additional CSS class for the container. */
    className?: string;
    /** Gap between grid cells (CSS value). @default "16px" */
    gap?: string;
    /** Horizontal padding on each page (CSS value). @default "0 20px" */
    pagePadding?: string;
    /** Zero-based index of the page to show initially. @default 0 */
    initialPage?: number;
    /** Show a footer bar with prev/next buttons and dot indicators. @default false */
    showFooter?: boolean;
    /** Additional CSS class for the footer bar. */
    footerClassName?: string;
    /** Wrapper component for nav buttons in the footer (e.g. MagneticWrapper). */
    NavButtonWrapper?: React.ComponentType<{ children: React.ReactNode }>;
}

/** Default wrapper that renders children without modification. */
const DefaultNavWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <>{children}</>
);

/**
 * A generic infinite carousel that arranges items in a
 * configurable grid (columns × rows) per page.
 */
function InfiniteCarouselInner<T>(
    {
        isHidden,
        items,
        numOfColumns,
        numOfRows,
        itemsPerPage: itemsPerPageProp,
        renderItem,
        keyExtractor,
        transitionMs = 400,
        transitionTimingFunction = "var(--anim-timing-ease-out-silky)",
        onScrollStateChange,
        onPageChange,
        className,
        gap = "0px",
        pagePadding = "0px",
        initialPage = 0,
        showFooter = true,
        footerClassName,
        NavButtonWrapper = DefaultNavWrapper,
    }: InfiniteCarouselProps<T>,
    ref: React.Ref<InfiniteCarouselHandle>,
) {

    const [isInteractionReady, setIsInteractionReady] = useState(false);

    // Add delay to the interaction ready state to
    // prevent the carousel from being interactable
    // too early
    useEffect(() => {
        if (!isHidden) {
            setTimeout(() => {
                setIsInteractionReady(true);
            }, 500);
        } else {
            setIsInteractionReady(false);
        }
    }, [isHidden]);

    const effectiveItemsPerPage = itemsPerPageProp ?? numOfColumns * numOfRows;

    const trackRef = useRef<HTMLDivElement>(null);
    // Track index includes clone pages: 0 = lastClone, 1..N = real pages, N+1 = firstClone
    // Initialize to 0 and let useLayoutEffect set the correct value before paint
    const [trackIndex, setTrackIndex] = useState(0);
    const [isAnimating, setIsAnimating] = useState(false);
    const [displayedPage, setDisplayedPage] = useState(0);

    // Keep callback ref stable to avoid stale closures
    const onPageChangeRef = useRef(onPageChange);
    useEffect(() => {
        onPageChangeRef.current = onPageChange;
    }, [onPageChange]);

    // Group items into pages
    const pages = useMemo(() => {
        const result: T[][] = [];
        for (let i = 0; i < items.length; i += effectiveItemsPerPage) {
            result.push(items.slice(i, i + effectiveItemsPerPage));
        }
        return result;
    }, [items, effectiveItemsPerPage]);

    const totalPages = pages.length;
    const canNavigate = totalPages > 1;

    // Build infinite track: [lastClone, ...realPages, firstClone]
    const infinitePages = useMemo(() => {
        if (totalPages === 0) return [];
        return [pages[totalPages - 1], ...pages, pages[0]];
    }, [pages, totalPages]);

    /**
     * Convert track index to real page index (0-based).
     * Track layout: [lastClone=0, page0=1, page1=2, ..., pageN=N, firstClone=N+1]
     */
    const trackIndexToPageIndex = useCallback(
        (index: number): number => {
            if (totalPages === 0) return 0;
            if (index <= 0) return totalPages - 1; // On last clone → last real page
            if (index > totalPages) return 0; // On first clone → first real page
            return index - 1;
        },
        [totalPages],
    );

    // Notify parent about scroll availability
    useEffect(() => {
        onScrollStateChange?.(canNavigate, canNavigate);
    }, [canNavigate, onScrollStateChange]);

    // Reset to initial page when page count changes, or when the carousel
    // becomes visible again after being hidden.
    // useLayoutEffect ensures the correct index is set before the browser
    // paints, preventing a flash of the wrong page when items load async.
    useLayoutEffect(() => {
        if (isHidden) return;

        const clampedPage = Math.max(0, Math.min(initialPage, totalPages - 1));
        const safeStartPage = totalPages > 0 ? clampedPage : 0;

        setTrackIndex(safeStartPage + 1);
        setDisplayedPage(safeStartPage);
        setIsAnimating(false);

        if (trackRef.current) {
            trackRef.current.style.transition = "none";
        }
        if (totalPages > 0) {
            onPageChangeRef.current?.(safeStartPage, totalPages);
        }
    }, [totalPages, initialPage, isHidden]);

    /** Instantly jump to a track index without animation (used after wrap-around). */
    const jumpToTrackIndex = useCallback(
        (index: number) => {
            const track = trackRef.current;
            if (!track) return;
            track.style.transition = "none";
            setTrackIndex(index);
            // Force reflow before re-enabling transition
            void track.offsetHeight;
            track.style.transition = `transform ${transitionMs}ms ${transitionTimingFunction}`;
        },
        [transitionMs, transitionTimingFunction],
    );

    /** Navigate to a track index with animation. */
    const animateToTrackIndex = useCallback(
        (index: number) => {
            if (isAnimating || !canNavigate) return;
            setIsAnimating(true);
            setTrackIndex(index);
        },
        [isAnimating, canNavigate],
    );

    const handleNext = useCallback(
        () => animateToTrackIndex(trackIndex + 1),
        [animateToTrackIndex, trackIndex],
    );

    const handlePrev = useCallback(
        () => animateToTrackIndex(trackIndex - 1),
        [animateToTrackIndex, trackIndex],
    );

    /** Handle wrap-around after animation completes. */
    const handleTransitionEnd = useCallback(() => {
        setIsAnimating(false);

        if (totalPages === 0) return;

        // If we landed on a clone, jump to the corresponding real page
        let finalTrackIndex = trackIndex;
        if (trackIndex === 0) {
            // Landed on last clone → jump to real last page
            finalTrackIndex = totalPages;
            jumpToTrackIndex(finalTrackIndex);
        } else if (trackIndex === totalPages + 1) {
            // Landed on first clone → jump to real first page
            finalTrackIndex = 1;
            jumpToTrackIndex(finalTrackIndex);
        }

        const realPage = trackIndexToPageIndex(finalTrackIndex);
        setDisplayedPage(realPage);
        onPageChangeRef.current?.(realPage, totalPages);
    }, [trackIndex, totalPages, jumpToTrackIndex, trackIndexToPageIndex]);

    useImperativeHandle(
        ref,
        () => ({
            scrollLeft: handlePrev,
            scrollRight: handleNext,
            canScrollLeft: canNavigate,
            canScrollRight: canNavigate,
        }),
        [handlePrev, handleNext, canNavigate],
    );

    const trackStyle: React.CSSProperties = {
        transform: `translateX(-${trackIndex * 100}%)`,
        transition: isAnimating
            ? `transform ${transitionMs}ms ${transitionTimingFunction}`
            : "none",
    };

    const pageStyle: React.CSSProperties = {
        gridTemplateColumns: `repeat(${numOfColumns}, 1fr)`,
        gridTemplateRows: `repeat(${numOfRows}, 1fr)`,
        gap,
        padding: pagePadding,
    };

    const containerClass = [
        "infinite-carousel-container",
        className,
    ]
        .filter(Boolean)
        .join(" ");

    return (
        <div className={containerClass}>
            <div className="infinite-carousel-viewport">
                <div
                    ref={trackRef}
                    className="infinite-carousel-track"
                    style={trackStyle}
                    onTransitionEnd={handleTransitionEnd}
                >
                    {infinitePages.map((page, pageIndex) => (
                        <div
                            key={`page-${pageIndex}`}
                            className="infinite-carousel-page"
                            style={pageStyle}
                        >
                            {page.map((item, itemIndex) => (
                                <React.Fragment
                                    key={keyExtractor(item, itemIndex)}
                                >
                                    {renderItem(item, itemIndex)}
                                </React.Fragment>
                            ))}
                        </div>
                    ))}
                </div>
            </div>
            {showFooter && canNavigate && (
                <div className={["scene-carousel-footer", footerClassName].filter(Boolean).join(" ")}>
                    <NavButtonWrapper>
                        <button
                            className="scene-carousel-footer-button"
                            onClick={handlePrev}
                            aria-label="Previous page"
                            disabled={!canNavigate || !isInteractionReady}
                        >
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M15 18L9 12L15 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                        </button>
                    </NavButtonWrapper>
                    <div className="scene-carousel-dots">
                        {Array.from({ length: totalPages }).map((_, idx) => (
                            <span
                                key={idx}
                                className={`scene-carousel-dot ${idx === displayedPage ? "active" : ""}`}
                            />
                        ))}
                    </div>
                    <NavButtonWrapper>
                        <button
                            className="scene-carousel-footer-button"
                            onClick={handleNext}
                            aria-label="Next page"
                            disabled={!canNavigate || !isInteractionReady}
                        >
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M9 18L15 12L9 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                        </button>
                    </NavButtonWrapper>
                </div>
            )}
        </div>
    );
}

// Wrap with forwardRef while preserving the generic type parameter
const InfiniteCarousel = forwardRef(InfiniteCarouselInner) as <T>(
    props: InfiniteCarouselProps<T> & {
        ref?: React.Ref<InfiniteCarouselHandle>;
    },
) => React.ReactElement | null;

export default InfiniteCarousel;
