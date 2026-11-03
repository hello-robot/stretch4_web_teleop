import Dialog from "@mui/material/Dialog";
import React from "react";

export const ForgotPassword = (props: {
    open: boolean;
    handleClose: () => void;
    handleExecute: (email: string) => void;
}) => {
    return (
        <Dialog
            open={props.open}
            onClose={props.handleClose}
            PaperProps={{
                component: "form",
                className: "lv-dialog",
                onSubmit: (event: React.FormEvent<HTMLFormElement>) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    props.handleExecute(data.get("email") as string);
                    props.handleClose();
                    event.stopPropagation();
                },
            }}
        >
            <h2 className="lv-dialog__title">Reset password</h2>
            <p className="lv-dialog__body">
                Enter your account&apos;s email address, and we&apos;ll send you a
                link to reset your password.
            </p>
            <label className="lv-label" htmlFor="reset-email">
                Email
            </label>
            <input
                className="lv-field"
                autoFocus
                required
                id="reset-email"
                name="email"
                placeholder="jsmith@hello-robot.com"
                type="email"
                autoComplete="email"
            />
            <div className="lv-dialog__actions">
                <button
                    type="button"
                    className="lv-button lv-button--ghost"
                    onClick={props.handleClose}
                >
                    Cancel
                </button>
                <button type="submit" className="lv-button lv-button--primary">
                    Continue
                </button>
            </div>
        </Dialog>
    );
};
