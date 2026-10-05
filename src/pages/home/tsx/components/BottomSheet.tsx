import Drawer from "@mui/material/Drawer";
import React from "react";

interface BottomSheetProps {
    open: boolean;
    title: string;
    icon: string;
    onClose: () => void;
    children: React.ReactNode;
}

export const BottomSheet = ({ open, title, icon, onClose, children }: BottomSheetProps) => (
    <Drawer
        anchor="bottom"
        open={open}
        onClose={onClose}
        PaperProps={{
            sx: {
                background: "var(--hr-card-bg-dim)",
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
                borderTop: "1px solid var(--hr-card-border)",
                borderRadius: "14px 14px 0 0",
                maxWidth: 520,
                margin: "0 auto",
            },
        }}
    >
        <div className="hr-sheet">
            <div className="hr-sheet__grip" />
            <h2 className="hr-sheet__title">
                <img alt="" src={icon} />
                {title}
            </h2>
            {children}
        </div>
    </Drawer>
);
