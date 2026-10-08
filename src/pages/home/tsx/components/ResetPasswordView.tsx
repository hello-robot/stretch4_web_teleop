import "home/css/LoginView.css";
import React, { useEffect, useState } from "react";
import { authErrorMessage } from "../authError";
import { loginHandler } from "../index";

type Phase = "checking" | "ready" | "done" | "invalid";

/** Shown when a password-reset email opens this site with mode=resetPassword. */
export const ResetPasswordView = ({ code }: { code: string }) => {
    const [phase, phaseSet] = useState<Phase>("checking");
    const [email, emailSet] = useState("");
    const [passwordError, passwordErrorSet] = useState("");
    const [banner, bannerSet] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        loginHandler.verifyPasswordReset(code).then(
            (accountEmail) => {
                if (cancelled) return;
                emailSet(accountEmail);
                phaseSet("ready");
            },
            (error) => {
                if (cancelled) return;
                bannerSet(authErrorMessage(error));
                phaseSet("invalid");
            },
        );
        return () => {
            cancelled = true;
        };
    }, [code]);

    const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const password = String(data.get("password") || "");
        const confirm = String(data.get("confirm") || "");
        if (password.length < 6) {
            passwordErrorSet("Use at least 6 characters.");
            return;
        }
        if (password !== confirm) {
            passwordErrorSet("Those passwords don't match.");
            return;
        }
        passwordErrorSet("");
        bannerSet(null);
        loginHandler.completePasswordReset(code, password).then(
            () => phaseSet("done"),
            (error) => bannerSet(authErrorMessage(error)),
        );
    };

    const backToSignIn = () => {
        window.location.assign(window.location.origin + "/");
    };

    return (
        <div className="lv-page">
            <header className="lv-header">
                <h1 className="lv-wordmark">hello robot</h1>
                <div className="lv-wordmark__sub">CLOUD</div>
            </header>
            <section className={`lv-card${banner ? " lv-card--error" : ""}`}>
                {banner && <div className="lv-card__error">{banner}</div>}
                {phase === "checking" && <p className="lv-dialog__body">Checking your reset link…</p>}
                {phase === "invalid" && (
                    <button type="button" className="lv-button lv-button--primary" onClick={backToSignIn}>
                        Back to sign in
                    </button>
                )}
                {phase === "ready" && (
                    <form className="lv-form" onSubmit={handleSubmit} noValidate>
                        <p className="lv-dialog__body">
                            Choose a new password for <strong>{email}</strong>.
                        </p>
                        <div className="lv-field-block">
                            <label className="lv-label" htmlFor="new-password">
                                New password
                            </label>
                            <input
                                className={`lv-field${passwordError ? " lv-field--error" : ""}`}
                                id="new-password"
                                name="password"
                                type="password"
                                autoComplete="new-password"
                                autoFocus
                                required
                            />
                        </div>
                        <div className="lv-field-block">
                            <label className="lv-label" htmlFor="confirm-password">
                                Confirm password
                            </label>
                            <input
                                className={`lv-field${passwordError ? " lv-field--error" : ""}`}
                                id="confirm-password"
                                name="confirm"
                                type="password"
                                autoComplete="new-password"
                                required
                            />
                            {passwordError && <p className="lv-field-error">{passwordError}</p>}
                        </div>
                        <button type="submit" className="lv-button lv-button--primary">
                            Save password
                        </button>
                    </form>
                )}
                {phase === "done" && (
                    <>
                        <p className="lv-dialog__body">Your password is updated.</p>
                        <button type="button" className="lv-button lv-button--primary" onClick={backToSignIn}>
                            Sign in
                        </button>
                    </>
                )}
            </section>
        </div>
    );
};
