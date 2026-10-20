import Dialog from "@mui/material/Dialog";
import Drawer from "@mui/material/Drawer";
import useMediaQuery from "@mui/material/useMediaQuery";
import React from "react";

interface BottomSheetProps {
    open: boolean;
    title: string;
    icon: string;
    onClose: () => void;
    children: React.ReactNode;
}

const DESKTOP_SHEET = "(min-width: 768px)";

export const BottomSheet = ({ open, title, icon, onClose, children }: BottomSheetProps) => {
    const desktop = useMediaQuery(DESKTOP_SHEET);
    const body = (
        <div className="hr-sheet">
            <div className="hr-sheet__grip" />
            <h2 className="hr-sheet__title">
                <img alt="" src={icon} />
                {title}
            </h2>
            {children}
        </div>
    );

    // MUI's bottom drawer pins the paper with a two-class rule and then
    // writes transform: none inline after the slide. A dialog is the centered
    // surface; the drawer stays the phone sheet.
    if (desktop) {
        return (
            <Dialog
                open={open}
                onClose={onClose}
                maxWidth={false}
                className="hr-sheet-dialog"
                PaperProps={{ className: "hr-sheet-dialog__paper" }}
            >
                {body}
            </Dialog>
        );
    }

    return (
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
            {body}
        </Drawer>
    );
};
