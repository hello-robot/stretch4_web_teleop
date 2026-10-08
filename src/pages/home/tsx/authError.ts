/** Short copy for the sign-in card. Never surface Firebase's raw error string. */
const AUTH_ERROR_COPY: Record<string, string> = {
    "auth/invalid-credential": "Incorrect email or password",
    "auth/invalid-login-credentials": "Incorrect email or password",
    "auth/wrong-password": "Incorrect email or password",
    "auth/user-not-found": "Incorrect email or password",
    "auth/invalid-email": "That email doesn't look right.",
    "auth/too-many-requests": "Too many attempts. Wait a moment and try again.",
    "auth/network-request-failed": "Can't reach sign-in. Check your connection.",
    "auth/popup-blocked": "The Google window was blocked. Allow popups and try again.",
    "auth/account-exists-with-different-credential":
        "That email uses a password. Sign in below.",
    "auth/expired-action-code": "This reset link has expired. Request a new one.",
    "auth/invalid-action-code": "This reset link is no longer valid. Request a new one.",
    "auth/weak-password": "Use at least 6 characters.",
};

export function authErrorMessage(error: { code?: string }): string {
    return (error.code && AUTH_ERROR_COPY[error.code]) || "Something went wrong. Try again.";
}
