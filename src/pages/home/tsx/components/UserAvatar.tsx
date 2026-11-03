import Menu from "@mui/material/Menu";
import React, { useEffect, useState } from "react";
import { emailInitials, gravatarUrl } from "../gravatar";
import { loginHandler } from "../index";

const AVATAR_PX = 30;

export const UserAvatar = ({ onError }: { onError: (message: string) => void }) => {
    const email = loginHandler.getUserEmail();
    const [imageUrl, imageUrlSet] = useState<string | null>(null);
    const [menuAnchor, menuAnchorSet] = useState<HTMLElement | null>(null);

    useEffect(() => {
        if (!email) return;
        let cancelled = false;
        gravatarUrl(email, AVATAR_PX * 2).then((url) => {
            if (!cancelled) imageUrlSet(url);
        });
        return () => {
            cancelled = true;
        };
    }, [email]);

    const handleLogout = () => {
        menuAnchorSet(null);
        loginHandler.logout().catch((error) => {
            onError(`Please contact Hello Robot Support. ERROR ${error.code}: ${error.message}`);
        });
    };

    return (
        <>
            <button
                type="button"
                className="hr-avatar"
                aria-label="Account menu"
                onClick={(event) => menuAnchorSet(event.currentTarget)}
            >
                {imageUrl ? (
                    <img alt="" src={imageUrl} onError={() => imageUrlSet(null)} />
                ) : (
                    <span className="hr-avatar__initials">{email ? emailInitials(email) : "?"}</span>
                )}
            </button>
            <Menu
                anchorEl={menuAnchor}
                open={menuAnchor !== null}
                onClose={() => menuAnchorSet(null)}
                anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
                transformOrigin={{ vertical: "top", horizontal: "right" }}
                slotProps={{
                    paper: { className: "hr-account" },
                    list: { className: "hr-account__list", disablePadding: true },
                }}
            >
                <button type="button" className="hr-account__logout" onClick={handleLogout}>
                    Logout
                </button>
            </Menu>
        </>
    );
};
