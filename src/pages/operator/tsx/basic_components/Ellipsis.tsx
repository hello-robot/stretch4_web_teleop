import React from "react";

interface EllipsisProps {
  size?: number;
  gap?: number;
  color?: string;
  duration?: number;
  ariaLabel?: string;
  className?: string;
}

export default function Ellipsis({
  size = 2,
  gap = 2,
  color = "currentColor",
  duration = 3000,
  ariaLabel = "Loading",
  className,
}: EllipsisProps) {
  const dot = (delay: number): React.CSSProperties => ({
    width: size,
    height: size,
    backgroundColor: color,
    opacity: 1,
    animation: `ellipsisFade ${duration}ms ease-in-out infinite`,
    animationDelay: `${delay}ms`,
  });

  return (
    <span
      role="status"
      aria-label={ariaLabel}
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap,
      }}
    >
      <span style={dot(0)} />
      <span style={dot(duration * 0.2)} />
      <span style={dot(duration * 0.4)} />

      <style>{`
        @keyframes ellipsisFade {
          0%   { opacity: 1; }
          30%  { opacity: 0.2; }
          60%  { opacity: 1; }
          100% { opacity: 1; }
        }

        @media (prefers-reduced-motion: reduce) {
          span[role="status"] > span {
            animation: none;
            opacity: 0.8;
          }
        }
      `}</style>
    </span>
  );
}
