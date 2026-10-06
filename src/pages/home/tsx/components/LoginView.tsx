import "home/css/LoginView.css";
import googleMark from "home/public/icons/google-g.png";
import Snackbar from "@mui/material/Snackbar";
import React, { useEffect, useRef, useState } from "react";
import { authErrorMessage } from "../authError";
import { loginHandler } from "../index";
import { ForgotPassword } from "./ForgotPassword";

/** Sign-in spinner stays up at least this long before the login request starts. */
const SIGN_IN_DELAY_MS = 500;

export const LoginView = () => {
    const [emailValue, setEmailValue] = useState("");
    const [passwordValue, setPasswordValue] = useState("");
    const [emailError, setEmailError] = useState(false);
    const [emailErrorMessage, setEmailErrorMessage] = useState("");
    const [passwordError, setPasswordError] = useState(false);
    const [passwordErrorMessage, setPasswordErrorMessage] = useState("");
    const [open, setOpen] = useState(false);
    const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
    const [signingIn, signingInSet] = useState(false);
    const [playReel, playReelSet] = useState(() => {
        const desktop = window.matchMedia("(min-width: 960px)").matches;
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        return desktop && !reduced;
    });
    const [lowUrl, lowUrlSet] = useState<string | undefined>();
    const [highUrl, highUrlSet] = useState<string | undefined>();
    const [highReady, highReadySet] = useState(false);
    const lowRef = useRef<HTMLVideoElement>(null);
    const highRef = useRef<HTMLVideoElement>(null);
    const lowUrlRef = useRef<string | undefined>();
    const highUrlRef = useRef<string | undefined>();
    const highShownRef = useRef(false);
    const signingInRef = useRef(false);
    const signInDelayRef = useRef<number | undefined>(undefined);

    useEffect(() => {
        const desktop = window.matchMedia("(min-width: 960px)");
        const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
        let cancelled = false;
        const sync = () => {
            const play = desktop.matches && !motion.matches;
            playReelSet(play);
            if (!play) {
                lowRef.current?.pause();
                highRef.current?.pause();
                return;
            }
            const start = (low: string, high: string | undefined) => {
                if (cancelled || !desktop.matches || motion.matches) return;
                lowUrlRef.current = low;
                lowUrlSet(low);
                const lowVideo = lowRef.current;
                if (lowVideo) {
                    if (lowVideo.src !== low) lowVideo.src = low;
                    if (!highShownRef.current) lowVideo.play().catch(() => undefined);
                }
                if (!high) return;
                highUrlRef.current = high;
                highUrlSet(high);
                if (highShownRef.current) highRef.current?.play().catch(() => undefined);
            };
            if (lowUrlRef.current) {
                start(lowUrlRef.current, highUrlRef.current);
                return;
            }
            import("home/public/video/hrobo-rgb-low.mp4").then((mod) => {
                if (cancelled) return;
                lowUrlRef.current = mod.default;
                start(mod.default, highUrlRef.current);
            });
            import("home/public/video/hrobo-rgb.mp4").then((mod) => {
                if (cancelled) return;
                highUrlRef.current = mod.default;
                if (lowUrlRef.current) start(lowUrlRef.current, mod.default);
            });
        };
        sync();
        desktop.addEventListener("change", sync);
        motion.addEventListener("change", sync);
        return () => {
            cancelled = true;
            desktop.removeEventListener("change", sync);
            motion.removeEventListener("change", sync);
        };
    }, []);

    useEffect(() => () => window.clearTimeout(signInDelayRef.current), []);

    const revealHigh = () => {
        const high = highRef.current;
        const low = lowRef.current;
        if (!high || highShownRef.current) return;
        highShownRef.current = true;
        if (low) {
            try {
                high.currentTime = low.currentTime;
            } catch {
                // A seek can reject before metadata is ready; playback still starts.
            }
        }
        high.play().then(
            () => highReadySet(true),
            () => {
                highShownRef.current = false;
            },
        );
    };

    const onHighError = () => {
        highShownRef.current = false;
        highReadySet(false);
        lowRef.current?.play().catch(() => undefined);
    };

    const onHighFadeEnd = (event: React.TransitionEvent<HTMLVideoElement>) => {
        if (event.propertyName !== "opacity" || !highShownRef.current) return;
        lowRef.current?.pause();
    };

    const handleForgotPassword = (email: string) => {
        loginHandler
            .forgot_password(email)
            .then(() => {
                setToast({ message: "Check your email for a reset link", error: false });
            })
            .catch((error) => {
                setToast({ message: authErrorMessage(error), error: true });
            });
    };

    const handleGoogleSignIn = () => {
        const remember = Boolean(
            (
                document.querySelector(
                    'input[name="remember"]',
                ) as HTMLInputElement | null
            )?.checked,
        );
        loginHandler.loginWithGoogle(remember).catch((error) => {
            setToast({ message: authErrorMessage(error), error: true });
        });
    };

    const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (signingInRef.current || !validateInputs()) {
            return;
        }

        const data = new FormData(event.currentTarget);
        const email = data.get("email") as string;
        const password = data.get("password") as string;
        const remember = Boolean(data.get("remember"));

        signingInRef.current = true;
        signingInSet(true);
        signInDelayRef.current = window.setTimeout(() => {
            loginHandler.login(email, password, remember).catch((error) => {
                signingInRef.current = false;
                signingInSet(false);
                setToast({ message: authErrorMessage(error), error: true });
            });
        }, SIGN_IN_DELAY_MS);
    };

    const validateInputs = () => {
        const email = document.getElementById("email") as HTMLInputElement;
        const password = document.getElementById("password") as HTMLInputElement;

        const emailOk = Boolean(email.value && /\S+@\S+\.\S+/.test(email.value));
        setEmailError(!emailOk);
        setEmailErrorMessage(emailOk ? "" : "Please enter a valid email address.");

        const passwordOk = Boolean(password.value && password.value.length >= 6);
        setPasswordError(!passwordOk);
        setPasswordErrorMessage(
            passwordOk ? "" : "Password must be at least 6 characters long.",
        );

        return emailOk && passwordOk;
    };

    const canSignIn = /\S+@\S+\.\S+/.test(emailValue) && passwordValue.length >= 6;

    return (
        <div className="lv-shell">
            <div className="lv-stage" aria-hidden="true">
                {lowUrl && (
                    <video
                        ref={lowRef}
                        className="lv-stage__video"
                        src={lowUrl}
                        autoPlay={playReel}
                        muted
                        loop
                        playsInline
                    />
                )}
                {highUrl && (
                    <video
                        ref={highRef}
                        className={`lv-stage__video lv-stage__video--high${highReady ? " lv-stage__video--ready" : ""}`}
                        src={highUrl}
                        preload="auto"
                        muted
                        loop
                        playsInline
                        onCanPlay={revealHigh}
                        onError={onHighError}
                        onTransitionEnd={onHighFadeEnd}
                    />
                )}
                <div className="lv-stage__hue" />
                <div className="lv-stage__veil" />
            </div>
            <div className="lv-page">
                <header className="lv-header">
                    <h1 className="lv-wordmark">hello robot</h1>
                    <div className="lv-wordmark__sub">CLOUD</div>
                </header>
                <section className="lv-card">
                    <form className="lv-form" onSubmit={handleSubmit} noValidate>
                        <div className="lv-field-block">
                            <label className="lv-label" htmlFor="email">
                                Email
                            </label>
                            <input
                                className={`lv-field${emailError ? " lv-field--error" : ""}`}
                                id="email"
                                type="email"
                                name="email"
                                placeholder="jsmith@hello-robot.com"
                                autoComplete="email"
                                autoFocus
                                required
                                aria-invalid={emailError}
                                value={emailValue}
                                onChange={(event) => setEmailValue(event.target.value)}
                            />
                            {emailErrorMessage && (
                                <p className="lv-field-error">{emailErrorMessage}</p>
                            )}
                        </div>
                        <div className="lv-field-block">
                            <div className="lv-label-row">
                                <label className="lv-label" htmlFor="password">
                                    Password
                                </label>
                                <button
                                    type="button"
                                    className="lv-forgot"
                                    onClick={() => setOpen(true)}
                                >
                                    Forgot your password?
                                </button>
                            </div>
                            <input
                                className={`lv-field${passwordError ? " lv-field--error" : ""}`}
                                id="password"
                                type="password"
                                name="password"
                                placeholder="••••••••••••"
                                autoComplete="current-password"
                                required
                                aria-invalid={passwordError}
                                value={passwordValue}
                                onChange={(event) => setPasswordValue(event.target.value)}
                            />
                            {passwordErrorMessage && (
                                <p className="lv-field-error">{passwordErrorMessage}</p>
                            )}
                        </div>
                        <label className="lv-remember">
                            <input type="checkbox" name="remember" value="remember" defaultChecked />
                            Remember me
                        </label>
                        <ForgotPassword
                            open={open}
                            handleClose={() => setOpen(false)}
                            handleExecute={handleForgotPassword}
                        />
                        <button
                            type="submit"
                            className={`lv-button ${canSignIn ? "lv-button--primary" : "lv-button--ghost"}`}
                            disabled={!canSignIn || signingIn}
                            aria-busy={signingIn}
                        >
                            {signingIn ? (
                                <span className="lv-button__spinner" role="status" aria-label="Signing in" />
                            ) : (
                                "Sign in"
                            )}
                        </button>
                    </form>
                    <div className="lv-or">or</div>
                    <button
                        type="button"
                        className="lv-button lv-button--primary"
                        onClick={handleGoogleSignIn}
                    >
                        <img className="lv-google__icon" src={googleMark} alt="" />
                        Continue with Google
                    </button>
                </section>
                <Snackbar
                    anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
                    open={toast !== null}
                    onClose={() => setToast(null)}
                    autoHideDuration={4000}
                    message={toast?.message ?? ""}
                    ContentProps={{
                        sx: {
                            background: toast?.error ? "#b3261e" : "#0b1014",
                            color: "#fff",
                            borderRadius: "10px",
                            fontFamily: "Rubik, sans-serif",
                            fontWeight: 500,
                            fontSize: "14px",
                            boxShadow: "none",
                        },
                    }}
                />
            </div>
        </div>
    );
};
